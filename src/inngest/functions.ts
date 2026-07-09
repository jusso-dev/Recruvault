import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { inngest, parseEvent } from "./client";
import { db } from "@/db";
import {
  accessTokens,
  deliveries,
  documents,
  organisations,
  requests,
  submissions,
  suppressions,
  user,
  walletDocuments,
} from "@/db/schema";
import { generateOpaqueToken } from "@/lib/crypto";
import {
  sendExpiryReminder,
  sendRecruiterSubmissionAlert,
  sendRequestInvite,
} from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { getObjectBytes, deleteObject } from "@/lib/storage";
import { scanBytes, sniffContentType } from "@/lib/scan";
import { audit } from "@/lib/audit";
import { findPurgeDueSubmissionIds, purgeSubmission } from "@/lib/retention";
import { getLogger } from "@/lib/logger";

const log = getLogger("inngest");
const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const DEFAULT_LINK_TTL_DAYS = 14;

/**
 * Deliver a request: mint the opaque secure link, then send it by email
 * (and optionally SMS) with Inngest handling retries and failures.
 */
export const deliverRequest = inngest.createFunction(
  {
    id: "deliver-request",
    retries: 3,
    triggers: [{ event: "request/send" }],
    onFailure: async ({ event, error }) => {
      // Retries exhausted: mark the delivery failed so the recruiter isn't
      // misled into thinking the candidate received the link.
      const original = event.data.event.data;
      await db
        .update(deliveries)
        .set({ status: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(deliveries.requestId, original.requestId),
            eq(deliveries.recipient, original.recipientEmail.toLowerCase()),
            inArray(deliveries.status, ["queued", "sent"]),
          ),
        );
      const [req] = await db.select().from(requests).where(eq(requests.id, original.requestId));
      await audit({
        orgId: req?.orgId,
        actorType: "system",
        action: "delivery.failed",
        targetType: "request",
        targetId: original.requestId,
      });
      log.error({ err: error, requestId: original.requestId }, "request delivery permanently failed");
    },
  },
  async ({ event, step }) => {
    const { requestId, recipientEmail, recipientPhone, sentBy } = parseEvent(
      "request/send",
      event.data,
    );

    const prepared = await step.run("create-token", async () => {
      const [req] = await db.select().from(requests).where(eq(requests.id, requestId));
      if (!req) throw new Error("Request not found.");
      const [org] = await db
        .select()
        .from(organisations)
        .where(eq(organisations.id, req.orgId));

      const { token, tokenHash } = generateOpaqueToken();
      const expiresAt =
        req.expiresAt ?? new Date(Date.now() + DEFAULT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

      const [at] = await db
        .insert(accessTokens)
        .values({
          requestId,
          tokenHash,
          recipientEmail: recipientEmail.toLowerCase(),
          recipientPhone,
          expiresAt,
        })
        .returning({ id: accessTokens.id });

      await db.insert(deliveries).values({
        requestId,
        accessTokenId: at.id,
        channel: "email",
        recipient: recipientEmail.toLowerCase(),
        status: "queued",
      });

      await audit({
        orgId: req.orgId,
        actorType: "org_user",
        actorId: sentBy,
        action: "request.sent",
        targetType: "access_token",
        targetId: at.id,
      });

      return {
        accessTokenId: at.id,
        link: `${APP_URL()}/r/${token}`,
        expiresAt: expiresAt.toISOString(),
        orgId: req.orgId,
        title: req.title,
        org: {
          orgName: org.name,
          senderName: org.branding?.senderName,
          sendingMode: org.sendingMode,
          sendingDomain: org.sendingDomain,
          sendingDomainVerifiedAt: org.sendingDomainVerifiedAt,
        },
      };
    });

    await step.run("send-email", async () => {
      const messageId = await sendRequestInvite({
        to: recipientEmail,
        org: prepared.org,
        requestTitle: prepared.title,
        link: prepared.link,
        expiresAt: new Date(prepared.expiresAt),
      });
      await db
        .update(deliveries)
        .set({ status: "sent", providerMessageId: messageId, updatedAt: new Date() })
        .where(
          and(
            eq(deliveries.accessTokenId, prepared.accessTokenId),
            eq(deliveries.channel, "email"),
          ),
        );
    });

    if (recipientPhone) {
      await step.run("send-sms", async () => {
        await db.insert(deliveries).values({
          requestId,
          accessTokenId: prepared.accessTokenId,
          channel: "sms",
          recipient: recipientPhone,
          status: "queued",
        });
        await sendSms({
          orgId: prepared.orgId,
          to: recipientPhone,
          message: `${prepared.org.orgName} sent you a secure request via Recruvault: ${prepared.link}`,
        });
        await db
          .update(deliveries)
          .set({ status: "sent", updatedAt: new Date() })
          .where(
            and(
              eq(deliveries.accessTokenId, prepared.accessTokenId),
              eq(deliveries.channel, "sms"),
            ),
          );
      });
    }

    return { accessTokenId: prepared.accessTokenId };
  },
);

/**
 * Scan an uploaded document before it becomes visible: fetch bytes, sniff the
 * real content type, run ClamAV, and quarantine anything that fails.
 */
export const scanDocument = inngest.createFunction(
  {
    id: "scan-document",
    retries: 2,
    triggers: [{ event: "document/uploaded" }],
    onFailure: async ({ event, error }) => {
      // Retries exhausted (e.g. clamd unreachable): mark the document errored
      // so it stays quarantined rather than stuck pending forever.
      const { documentId, table } = event.data.event.data;
      const tbl = table === "documents" ? documents : walletDocuments;
      await db.update(tbl).set({ scanStatus: "error" }).where(eq(tbl.id, documentId));
      await audit({
        actorType: "system",
        action: "document.scan.error",
        targetType: table === "documents" ? "document" : "wallet_document",
        targetId: documentId,
      });
      log.error({ err: error, documentId }, "document scan permanently failed");
    },
  },
  async ({ event, step }) => {
    const { documentId, table } = parseEvent("document/uploaded", event.data);

    const result = await step.run("scan", async () => {
      const tbl = table === "documents" ? documents : walletDocuments;
      const [doc] = await db.select().from(tbl).where(eq(tbl.id, documentId));
      if (!doc) return "missing";

      let bytes: Buffer;
      try {
        bytes = await getObjectBytes(doc.storageKey);
      } catch {
        await db.update(tbl).set({ scanStatus: "error" }).where(eq(tbl.id, documentId));
        return "error";
      }

      const sniffed = sniffContentType(bytes);
      if (!sniffed) {
        await db.update(tbl).set({ scanStatus: "infected" }).where(eq(tbl.id, documentId));
        await deleteObject(doc.storageKey);
        return "rejected_content_type";
      }

      const verdict = await scanBytes(bytes);
      await db.update(tbl).set({ scanStatus: verdict }).where(eq(tbl.id, documentId));
      if (verdict === "infected") await deleteObject(doc.storageKey);

      await audit({
        // Org documents land on the org chain; wallet documents are candidate-
        // side (global chain, orgId null).
        orgId: table === "documents" ? (doc as { orgId: string }).orgId : null,
        actorType: "system",
        action: `document.scan.${verdict}`,
        targetType: table === "documents" ? "document" : "wallet_document",
        targetId: documentId,
      });
      return verdict;
    });

    return { result };
  },
);

/** Notify the request owner when a submission lands. */
export const submissionReceived = inngest.createFunction(
  { id: "submission-received", retries: 3, triggers: [{ event: "submission/received" }] },
  async ({ event, step }) => {
    await step.run("notify-recruiter", async () => {
      const { submissionId } = parseEvent("submission/received", event.data);
      const [sub] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      if (!sub) return;
      const [req] = await db.select().from(requests).where(eq(requests.id, sub.requestId));
      if (!req) return;
      const [owner] = await db.select().from(user).where(eq(user.id, req.createdBy));
      if (!owner) return;
      await sendRecruiterSubmissionAlert({
        to: owner.email,
        requestTitle: req.title,
        reviewUrl: `${APP_URL()}/dashboard/requests/${req.id}/submissions/${sub.id}`,
      });
    });
  },
);

/**
 * Daily retention sweep: collect all due submissions, then fan out one event
 * per submission so a single failure is isolated, retried, and countable
 * rather than aborting the whole run.
 */
export const retentionPurge = inngest.createFunction(
  { id: "retention-purge", triggers: [{ cron: "0 16 * * *" }] }, // 02:00 AEST
  async ({ step }) => {
    const ids = await step.run("collect", () => findPurgeDueSubmissionIds());
    if (ids.length > 0) {
      await step.sendEvent(
        "fan-out",
        ids.map((submissionId) => ({
          name: "retention/purge.submission" as const,
          data: { submissionId },
        })),
      );
    }
    return { due: ids.length };
  },
);

/** Purge a single submission (fanned out from the retention sweep). */
export const purgeSubmissionJob = inngest.createFunction(
  {
    id: "purge-submission",
    retries: 3,
    triggers: [{ event: "retention/purge.submission" }],
    onFailure: async ({ event, error }) => {
      const { submissionId } = event.data.event.data;
      await audit({
        actorType: "system",
        action: "submission.purge_failed",
        targetType: "submission",
        targetId: submissionId,
      });
      log.error({ err: error, submissionId }, "submission purge permanently failed");
    },
  },
  async ({ event, step }) => {
    const { submissionId } = parseEvent("retention/purge.submission", event.data);
    await step.run("purge", () =>
      purgeSubmission(submissionId, { actorType: "system" }),
    );
    return { submissionId };
  },
);

/** Remind recipients whose secure links expire within 48 hours. */
export const expiryReminders = inngest.createFunction(
  { id: "expiry-reminders", triggers: [{ cron: "0 22 * * *" }] }, // 08:00 AEST
  async ({ step }) => {
    const soon = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const due = await step.run("collect", async () =>
      db
        .select({
          tokenId: accessTokens.id,
          email: accessTokens.recipientEmail,
          expiresAt: accessTokens.expiresAt,
          requestId: accessTokens.requestId,
        })
        .from(accessTokens)
        .where(
          and(
            isNull(accessTokens.consumedAt),
            isNull(accessTokens.revokedAt),
            isNull(accessTokens.reminderSentAt),
            lt(accessTokens.expiresAt, soon),
            gt(accessTokens.expiresAt, new Date()),
          ),
        ),
    );

    let count = 0;
    // Each reminder is its own step so one bad address doesn't abort the rest,
    // and completed sends are memoised across retries.
    for (const t of due) {
      const sent = await step.run(`remind-${t.tokenId}`, async () => {
        const [req] = await db.select().from(requests).where(eq(requests.id, t.requestId));
        if (!req || req.status === "closed" || req.status === "archived") return false;
        const [org] = await db
          .select()
          .from(organisations)
          .where(eq(organisations.id, req.orgId));

        // The original opaque token is unrecoverable (only its hash is stored),
        // so rotate the token and send a fresh working link. The old link stops
        // working — acceptable, as it was about to expire anyway.
        const { token, tokenHash } = generateOpaqueToken();
        await db
          .update(accessTokens)
          .set({ tokenHash, reminderSentAt: new Date() })
          .where(eq(accessTokens.id, t.tokenId));

        await sendExpiryReminder({
          to: t.email,
          org: {
            orgName: org.name,
            senderName: org.branding?.senderName,
            sendingMode: org.sendingMode,
            sendingDomain: org.sendingDomain,
            sendingDomainVerifiedAt: org.sendingDomainVerifiedAt,
          },
          requestTitle: req.title,
          link: `${APP_URL()}/r/${token}`,
          expiresAt: new Date(t.expiresAt),
        });
        await audit({
          orgId: req.orgId,
          actorType: "system",
          action: "link.reminder_sent",
          targetType: "access_token",
          targetId: t.tokenId,
        });
        return true;
      });
      if (sent) count++;
    }
    return { reminded: count };
  },
);

/** Resend webhook events: suppress hard bounces and complaints. */
export const emailEvents = inngest.createFunction(
  { id: "email-events", triggers: [{ event: "email/event" }] },
  async ({ event, step }) => {
    await step.run("handle", async () => {
      const { type, email, messageId } = parseEvent("email/event", event.data);
      if (type === "email.bounced" || type === "email.complained") {
        await db
          .insert(suppressions)
          .values({ email: email.toLowerCase(), reason: type })
          .onConflictDoNothing();
        // Mark only the delivery this event refers to. Fall back to recipient
        // match when the provider gives us no message id.
        await db
          .update(deliveries)
          .set({ status: "bounced", updatedAt: new Date() })
          .where(
            messageId
              ? eq(deliveries.providerMessageId, messageId)
              : eq(deliveries.recipient, email.toLowerCase()),
          );
      }
    });
  },
);

export const functions = [
  deliverRequest,
  scanDocument,
  submissionReceived,
  retentionPurge,
  purgeSubmissionJob,
  expiryReminders,
  emailEvents,
];
