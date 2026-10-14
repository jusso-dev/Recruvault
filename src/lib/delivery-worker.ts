import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, deliveries, organisations, requests, submissions, user } from "@/db/schema";
import { consumeOnce } from "@/lib/outbox";
import { deliveryLinkToken } from "@/lib/link-token";
import { sendRecruiterSubmissionAlert, sendRequestInvite } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { activeVault } from "@/lib/vault-store";

/**
 * Side effects behind the `request/send` and `submission/received` events.
 * Each one runs through consumeOnce, so a replayed or duplicated event never
 * sends a second invitation, SMS, or recruiter alert. The secure link is
 * rebuilt here and never returned, so Inngest step output never holds it.
 */

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";

export type DeliveryOutcome = "sent" | "not_sent" | "duplicate" | "skipped";

async function loadDelivery(deliveryId: string) {
  const [row] = await db
    .select({
      deliveryId: deliveries.id,
      status: deliveries.status,
      recipient: deliveries.recipient,
      accessTokenId: accessTokens.id,
      tokenHash: accessTokens.tokenHash,
      recipientPhone: accessTokens.recipientPhone,
      expiresAt: accessTokens.expiresAt,
      revokedAt: accessTokens.revokedAt,
      consumedAt: accessTokens.consumedAt,
      requestId: requests.id,
      requestTitle: requests.title,
      orgId: organisations.id,
      orgName: organisations.name,
      branding: organisations.branding,
      sendingMode: organisations.sendingMode,
      sendingDomain: organisations.sendingDomain,
      sendingDomainVerifiedAt: organisations.sendingDomainVerifiedAt,
    })
    .from(deliveries)
    .innerJoin(accessTokens, eq(accessTokens.id, deliveries.accessTokenId))
    .innerJoin(requests, eq(requests.id, deliveries.requestId))
    .innerJoin(organisations, eq(organisations.id, requests.orgId))
    .where(eq(deliveries.id, deliveryId));
  return row;
}

type LoadedDelivery = NonNullable<Awaited<ReturnType<typeof loadDelivery>>>;

/**
 * Fail closed when the organisation has no usable vault (never enrolled, or
 * shredded): nothing is sent and the queued deliveries are marked failed, so
 * the recruiter does not see a false "sent". Retrying cannot fix this.
 */
async function vaultBlocks(row: LoadedDelivery): Promise<boolean> {
  const vault = await activeVault("organisation", row.orgId);
  if (vault?.privateKeyWrapped) return false;
  await db
    .update(deliveries)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(deliveries.accessTokenId, row.accessTokenId), eq(deliveries.status, "queued")));
  return true;
}

/** Rebuild the link. Re-pins the hash if the link secret changed since queueing. */
async function linkFor(row: LoadedDelivery): Promise<string> {
  const { token, tokenHash } = deliveryLinkToken(row.accessTokenId);
  if (row.tokenHash !== tokenHash) {
    await db.update(accessTokens).set({ tokenHash }).where(eq(accessTokens.id, row.accessTokenId));
  }
  return `${APP_URL()}/r/${token}`;
}

function orgSender(row: LoadedDelivery) {
  return {
    orgName: row.orgName,
    senderName: row.branding?.senderName,
    sendingMode: row.sendingMode,
    sendingDomain: row.sendingDomain,
    sendingDomainVerifiedAt: row.sendingDomainVerifiedAt,
  };
}

export async function sendDeliveryEmail(
  deliveryId: string,
  sendInvite: typeof sendRequestInvite = sendRequestInvite,
): Promise<DeliveryOutcome> {
  const row = await loadDelivery(deliveryId);
  if (!row || row.revokedAt || row.consumedAt) return "skipped";
  if (row.status !== "queued") return "duplicate";
  if (await vaultBlocks(row)) return "skipped";

  let outcome: DeliveryOutcome = "sent";
  const ran = await consumeOnce(`request/send:${deliveryId}:email`, async () => {
    const messageId = await sendInvite({
      to: row.recipient,
      org: orgSender(row),
      requestTitle: row.requestTitle,
      link: await linkFor(row),
      expiresAt: row.expiresAt,
    });
    // null means suppressed or no provider in development: not delivered.
    outcome = messageId ? "sent" : "not_sent";
    await db
      .update(deliveries)
      .set({ status: messageId ? "sent" : "failed", providerMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")));
  });
  return ran === "duplicate" ? "duplicate" : outcome;
}

export async function sendDeliverySms(
  deliveryId: string,
  send: typeof sendSms = sendSms,
): Promise<DeliveryOutcome> {
  const row = await loadDelivery(deliveryId);
  if (!row || !row.recipientPhone || row.revokedAt || row.consumedAt) return "skipped";
  const phone = row.recipientPhone;
  if (await vaultBlocks(row)) return "skipped";

  let outcome: DeliveryOutcome = "sent";
  const ran = await consumeOnce(`request/send:${deliveryId}:sms`, async () => {
    let [sms] = await db
      .select({ id: deliveries.id, status: deliveries.status })
      .from(deliveries)
      .where(and(eq(deliveries.accessTokenId, row.accessTokenId), eq(deliveries.channel, "sms")));
    if (!sms) {
      [sms] = await db
        .insert(deliveries)
        .values({
          requestId: row.requestId,
          accessTokenId: row.accessTokenId,
          channel: "sms",
          recipient: phone,
          status: "queued",
        })
        .returning({ id: deliveries.id, status: deliveries.status });
    }
    if (sms.status !== "queued") {
      outcome = "duplicate";
      return;
    }
    const sent = await send({
      orgId: row.orgId,
      to: phone,
      message: `${row.orgName} sent you a secure request via Recruvault: ${await linkFor(row)}`,
    });
    outcome = sent ? "sent" : "not_sent";
    await db
      .update(deliveries)
      .set({ status: sent ? "sent" : "failed", updatedAt: new Date() })
      .where(eq(deliveries.id, sms.id));
  });
  return ran === "duplicate" ? "duplicate" : outcome;
}

/** Tell the request owner a submission arrived, once per submission. */
export async function notifySubmissionReceived(
  submissionId: string,
  sendAlert: typeof sendRecruiterSubmissionAlert = sendRecruiterSubmissionAlert,
): Promise<DeliveryOutcome> {
  const [row] = await db
    .select({
      submissionId: submissions.id,
      requestId: requests.id,
      requestTitle: requests.title,
      ownerEmail: user.email,
    })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .innerJoin(user, eq(user.id, requests.createdBy))
    .where(eq(submissions.id, submissionId));
  if (!row) return "skipped";

  const ran = await consumeOnce(`submission/received:${submissionId}`, async () => {
    await sendAlert({
      to: row.ownerEmail,
      requestTitle: row.requestTitle,
      reviewUrl: `${APP_URL()}/dashboard/requests/${row.requestId}/submissions/${row.submissionId}`,
    });
  });
  return ran === "duplicate" ? "duplicate" : "sent";
}
