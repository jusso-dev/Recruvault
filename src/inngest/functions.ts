import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { inngest, parseEvent } from "./client";
import { db } from "@/db";
import {
  accessTokens,
  deliveries,
  documents,
  organisations,
  requests,
  walletDocuments,
} from "@/db/schema";
import { generateOpaqueToken } from "@/lib/crypto";
import { applyEmailEvent, sendExpiryReminder } from "@/lib/email";
import { getObjectBytes, deleteObject } from "@/lib/storage";
import { scanBytes, sniffContentType } from "@/lib/scan";
import { audit } from "@/lib/audit";
import { findPurgeDueSubmissionIds, purgeSubmission, resumeIncompleteErasures } from "@/lib/retention";
import { outboxStats, publishPendingOutbox, pruneOutbox, reconcileOutbox } from "@/lib/outbox";
import { pruneRateLimits } from "@/lib/rate-limit";
import { notifySubmissionReceived, sendDeliveryEmail, sendDeliverySms } from "@/lib/delivery-worker";
import { queueRequestDelivery } from "@/lib/requests-service";
import { processDeletionTasks } from "@/lib/deletion-queue";
import { reconcileStorage } from "@/lib/storage-reconciler";
import { migrateLegacyDocuments } from "@/lib/document-migration";
import { nightlyBackupIfDue } from "@/lib/backup";
import { getLogger } from "@/lib/logger";
import { deliverJobMatch, queueJobMatches } from "@/lib/job-matches";

const log = getLogger("inngest");
const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";

/**
 * Deliver a queued secure link by email (and optionally SMS). The access token
 * and delivery row were committed together with this event, so the function
 * only sends. Sends are idempotent per delivery (see lib/delivery-worker), and
 * no step returns the link, so Inngest never stores it.
 */
export const deliverRequest = inngest.createFunction(
  {
    id: "deliver-request",
    retries: 3,
    triggers: [{ event: "request/send" }],
    onFailure: async ({ event, error }) => {
      // Retries exhausted: mark what is still queued as failed so the
      // recruiter isn't misled into thinking the candidate received the link.
      const original = event.data.event.data as {
        requestId: string;
        deliveryId?: string;
        recipientEmail?: string;
      };
      if (original.deliveryId) {
        const [delivery] = await db
          .select({ accessTokenId: deliveries.accessTokenId })
          .from(deliveries)
          .where(eq(deliveries.id, original.deliveryId));
        if (delivery) {
          await db
            .update(deliveries)
            .set({ status: "failed", updatedAt: new Date() })
            .where(and(eq(deliveries.accessTokenId, delivery.accessTokenId), eq(deliveries.status, "queued")));
        }
      } else if (original.recipientEmail) {
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
      }
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
    const data = parseEvent("request/send", event.data);

    if (!data.deliveryId) {
      // Queued before deliveries were committed with their event: create the
      // delivery row now. Its own id-only event performs the send.
      const recipientEmail = data.recipientEmail;
      if (!recipientEmail) return { skipped: "no recipient" };
      const deliveryId = await step.run("queue-legacy", async () => {
        const [req] = await db.select().from(requests).where(eq(requests.id, data.requestId));
        if (!req) return null;
        const queued = await queueRequestDelivery({
          orgId: req.orgId,
          sentBy: data.sentBy,
          request: req,
          recipientEmail,
          recipientPhone: data.recipientPhone,
        });
        return queued.deliveryId;
      });
      return { requeued: deliveryId };
    }

    const deliveryId = data.deliveryId;
    const email = await step.run("send-email", () => sendDeliveryEmail(deliveryId));
    const sms = await step.run("send-sms", () => sendDeliverySms(deliveryId));
    return { deliveryId, email, sms };
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
      // Ciphertext is scanned before it is stored. A lost event must not treat
      // those bytes as a document, and it must not mark an already-clean file
      // pending again.
      if (doc.scanStatus !== "pending" || doc.envelopeVersion > 0) return doc.scanStatus;

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

/** Notify the request owner when a submission lands, once per submission. */
export const submissionReceived = inngest.createFunction(
  { id: "submission-received", retries: 3, triggers: [{ event: "submission/received" }] },
  async ({ event, step }) => {
    const { submissionId } = parseEvent("submission/received", event.data);
    const outcome = await step.run("notify-recruiter", () => notifySubmissionReceived(submissionId));
    return { outcome };
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
    // Step output is stored by Inngest: collect ids only, never addresses.
    const due = await step.run("collect", async () =>
      db
        .select({
          tokenId: accessTokens.id,
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
        // Claiming reminderSentAt first keeps a repeated run from sending twice.
        const { token, tokenHash } = generateOpaqueToken();
        const [claimed] = await db
          .update(accessTokens)
          .set({ tokenHash, reminderSentAt: new Date() })
          .where(and(eq(accessTokens.id, t.tokenId), isNull(accessTokens.reminderSentAt)))
          .returning({ email: accessTokens.recipientEmail, expiresAt: accessTokens.expiresAt });
        if (!claimed) return false;

        await sendExpiryReminder({
          to: claimed.email,
          org: {
            orgName: org.name,
            senderName: org.branding?.senderName,
            sendingMode: org.sendingMode,
            sendingDomain: org.sendingDomain,
            sendingDomainVerifiedAt: org.sendingDomainVerifiedAt,
          },
          requestTitle: req.title,
          link: `${APP_URL()}/r/${token}`,
          expiresAt: claimed.expiresAt,
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

/**
 * Legacy Resend events queued before the webhook applied them directly.
 * Kept so those rows still drain.
 */
export const emailEvents = inngest.createFunction(
  { id: "email-events", triggers: [{ event: "email/event" }] },
  async ({ event, step }) => {
    await step.run("handle", () => applyEmailEvent(parseEvent("email/event", event.data)));
  },
);

/** Match one newly listed role against explicitly subscribed job seekers. */
export const listedRoleJobAlerts = inngest.createFunction(
  {
    id: "listed-role-job-alerts",
    retries: 3,
    triggers: [{ event: "job-alert/role-listed" }],
  },
  async ({ event, step }) => {
    const { requestId } = parseEvent("job-alert/role-listed", event.data);
    const ids = await step.run("queue-matches", () => queueJobMatches({ requestId }));
    for (const notificationId of ids) {
      await step.run(`deliver-${notificationId}`, () => deliverJobMatch(notificationId));
    }
    return { matched: ids.length };
  },
);

/** Evaluate current listed roles when a job seeker enables or changes alerts. */
export const subscriptionJobAlerts = inngest.createFunction(
  {
    id: "subscription-job-alerts",
    retries: 3,
    triggers: [{ event: "job-alert/subscription-updated" }],
  },
  async ({ event, step }) => {
    const { candidateAccountId } = parseEvent(
      "job-alert/subscription-updated",
      event.data,
    );
    const ids = await step.run("queue-matches", () =>
      queueJobMatches({ candidateAccountId }),
    );
    for (const notificationId of ids) {
      await step.run(`deliver-${notificationId}`, () => deliverJobMatch(notificationId));
    }
    return { matched: ids.length };
  },
);

export const publishOutbox = inngest.createFunction(
  { id: "publish-outbox", triggers: [{ cron: "*/1 * * * *" }] },
  async ({ step }) => {
    const published = await step.run("publish", () => publishPendingOutbox());
    return { published };
  },
);

/**
 * Outbox upkeep: re-create events for committed work that has none, prune
 * old rows and rate-limit windows, and log depth so stuck or dead events are
 * visible in operational logs.
 */
export const outboxMaintenance = inngest.createFunction(
  { id: "outbox-maintenance", retries: 1, triggers: [{ cron: "*/15 * * * *" }] },
  async ({ step }) => {
    const reconciled = await step.run("reconcile", () => reconcileOutbox());
    const pruned = await step.run("prune", () => pruneOutbox());
    const rateLimitsPruned = await step.run("prune-rate-limits", () => pruneRateLimits());
    const stats = await step.run("stats", async () => {
      const current = await outboxStats();
      const line = { ...current, reconciled, pruned, metric: "outbox_depth" };
      if (current.dead > 0 || current.oldestPendingSeconds > 900) log.warn(line, "outbox needs attention");
      else log.info(line, "outbox depth");
      return current;
    });
    return { reconciled, pruned, rateLimitsPruned, ...stats };
  },
);

export const retryDeletions = inngest.createFunction(
  { id: "retry-deletions", triggers: [{ cron: "*/1 * * * *" }] },
  async ({ step }) => {
    const finished = await step.run("delete", () => processDeletionTasks());
    return { finished };
  },
);

/** Finish account erasures that stopped between their transactions. */
export const resumeErasures = inngest.createFunction(
  { id: "resume-erasures", triggers: [{ cron: "*/5 * * * *" }] },
  async ({ step }) => {
    const resumed = await step.run("resume", () => resumeIncompleteErasures());
    return { resumed };
  },
);

/** Queue orphaned objects, report stuck or dead deletion work, finish erasure records. */
export const reconcileStorageJob = inngest.createFunction(
  { id: "reconcile-storage", retries: 1, triggers: [{ cron: "17 * * * *" }] },
  async ({ step }) => step.run("reconcile", () => reconcileStorage()),
);

/** Encrypt legacy plaintext objects in small resumable batches until none remain. */
export const migrateLegacyDocumentsJob = inngest.createFunction(
  {
    id: "migrate-legacy-documents",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step }) => step.run("migrate-batch", () => migrateLegacyDocuments()),
);

export const nightlyBackup = inngest.createFunction(
  { id: "nightly-backup", retries: 1, triggers: [{ cron: "0 * * * *" }] },
  async ({ step }) => step.run("backup-if-due", () => nightlyBackupIfDue()),
);

export const functions = [
  deliverRequest,
  scanDocument,
  submissionReceived,
  retentionPurge,
  purgeSubmissionJob,
  expiryReminders,
  emailEvents,
  listedRoleJobAlerts,
  subscriptionJobAlerts,
  publishOutbox,
  outboxMaintenance,
  retryDeletions,
  resumeErasures,
  reconcileStorageJob,
  migrateLegacyDocumentsJob,
  nightlyBackup,
];
