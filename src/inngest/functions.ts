import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { inngest } from "./client";
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
import { runRetentionPurge } from "@/lib/retention";

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const DEFAULT_LINK_TTL_DAYS = 14;

/**
 * Deliver a request: mint the opaque secure link, then send it by email
 * (and optionally SMS) with Inngest handling retries and failures.
 */
export const deliverRequest = inngest.createFunction(
  { id: "deliver-request", retries: 3, triggers: [{ event: "request/send" }] },
  async ({ event, step }) => {
    const { requestId, recipientEmail, recipientPhone, sentBy } = event.data as {
      requestId: string;
      recipientEmail: string;
      recipientPhone?: string;
      sentBy: string;
    };

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
      await sendRequestInvite({
        to: recipientEmail,
        org: prepared.org,
        requestTitle: prepared.title,
        link: prepared.link,
        expiresAt: new Date(prepared.expiresAt),
      });
      await db
        .update(deliveries)
        .set({ status: "sent", updatedAt: new Date() })
        .where(eq(deliveries.accessTokenId, prepared.accessTokenId));
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
  { id: "scan-document", retries: 2, triggers: [{ event: "document/uploaded" }] },
  async ({ event, step }) => {
    const { documentId, table } = event.data as {
      documentId: string;
      table: "documents" | "wallet_documents";
    };

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
      const [sub] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, (event.data as { submissionId: string }).submissionId));
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

/** Daily retention purge across all organisations. */
export const retentionPurge = inngest.createFunction(
  { id: "retention-purge", triggers: [{ cron: "0 16 * * *" }] }, // 02:00 AEST
  async ({ step }) => {
    const purged = await step.run("purge", () => runRetentionPurge());
    return { purged };
  },
);

/** Remind recipients whose secure links expire within 48 hours. */
export const expiryReminders = inngest.createFunction(
  { id: "expiry-reminders", triggers: [{ cron: "0 22 * * *" }] }, // 08:00 AEST
  async ({ step }) => {
    const reminded = await step.run("remind", async () => {
      const soon = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const due = await db
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
            lt(accessTokens.expiresAt, soon),
            gt(accessTokens.expiresAt, new Date()),
          ),
        );

      let count = 0;
      for (const t of due) {
        const [req] = await db.select().from(requests).where(eq(requests.id, t.requestId));
        if (!req || req.status === "closed" || req.status === "archived") continue;
        const [org] = await db
          .select()
          .from(organisations)
          .where(eq(organisations.id, req.orgId));
        // The original opaque token is unrecoverable by design (only its hash is
        // stored), so the reminder directs the recipient back through the app.
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
          link: `${APP_URL()}`,
          expiresAt: t.expiresAt,
        });
        count++;
      }
      return count;
    });
    return { reminded };
  },
);

/** Resend webhook events: suppress hard bounces and complaints. */
export const emailEvents = inngest.createFunction(
  { id: "email-events", triggers: [{ event: "email/event" }] },
  async ({ event, step }) => {
    await step.run("handle", async () => {
      const { type, email } = event.data as { type: string; email: string };
      if (type === "email.bounced" || type === "email.complained") {
        await db
          .insert(suppressions)
          .values({ email: email.toLowerCase(), reason: type })
          .onConflictDoNothing();
        await db
          .update(deliveries)
          .set({ status: "bounced", updatedAt: new Date() })
          .where(eq(deliveries.recipient, email.toLowerCase()));
      }
    });
  },
);

export const functions = [
  deliverRequest,
  scanDocument,
  submissionReceived,
  retentionPurge,
  expiryReminders,
  emailEvents,
];
