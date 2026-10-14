import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  account,
  auditEvents,
  candidateAccounts,
  candidateApiKeys,
  consents,
  deliveries,
  documents,
  erasureRecords,
  organisations,
  passkey,
  requests,
  savedRoles,
  session,
  submissionDocuments,
  submissions,
  submissionValues,
  user,
  vaultKeys,
  verification,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { shredDataKey } from "@/lib/crypto";
import { completeFinishedErasures, enqueueDeletion, processDeletionTasks } from "@/lib/deletion-queue";
import { deleteObject } from "@/lib/storage";
import { audit } from "@/lib/audit";

/**
 * Retention and deletion.
 *
 * Deletion is a crypto-shred. One transaction revokes access, destroys every
 * data key for the record (fields and documents), queues each storage object
 * on the durable deletion queue, deletes the rows, and records progress in
 * erasure_records. Object deletion runs afterwards through the queue, which
 * retries, dead-letters, and is reconciled. A crash between steps leaves
 * either nothing changed or a durable record that the jobs resume.
 *
 * The submission row survives with purgedAt set so the audit trail keeps a
 * metadata-only record of handling after the PII is gone. See docs/data-map.md.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = { actorType: "system" | "org_user" | "candidate"; actorId?: string };

const DAY_MS = 24 * 60 * 60 * 1000;
// Under purge-on-close a role that never closes or expires is still capped:
// any submission is purged this long after its own retention window.
export const OPEN_ROLE_BACKSTOP_DAYS = 365;
const REDACTED = "redacted";

async function openErasureRecord(tx: Tx, subjectType: string, subjectId: string) {
  await tx
    .insert(erasureRecords)
    .values({ subjectType, subjectId })
    .onConflictDoNothing({ target: [erasureRecords.subjectType, erasureRecords.subjectId] });
  const [row] = await tx
    .select()
    .from(erasureRecords)
    .where(and(eq(erasureRecords.subjectType, subjectType), eq(erasureRecords.subjectId, subjectId)))
    .for("update");
  return row;
}

/**
 * Audit events keep ids, actions, and times. The network address and user
 * agent are not part of the hash chain, so they can be cleared without
 * breaking verification.
 */
async function scrubAuditNetworkData(tx: Tx, actorType: "candidate" | "link_responder", actorId: string) {
  await tx
    .update(auditEvents)
    .set({ ip: null, userAgent: null })
    .where(and(eq(auditEvents.actorType, actorType), eq(auditEvents.actorId, actorId)));
}

/** Shred, queue, and delete one submission's PII inside the caller's transaction. */
async function purgeSubmissionRows(
  tx: Tx,
  sub: { id: string; requestId: string; accessTokenId: string | null },
  erasureId: string,
): Promise<{ queued: number; orgId: string | null }> {
  const [req] = await tx
    .select({ orgId: requests.orgId })
    .from(requests)
    .where(eq(requests.id, sub.requestId));
  const values = await tx
    .select({ dekId: submissionValues.dekId })
    .from(submissionValues)
    .where(eq(submissionValues.submissionId, sub.id));
  const docs = await tx
    .select({
      documentId: submissionDocuments.documentId,
      storageKey: documents.storageKey,
      dekId: documents.dekId,
    })
    .from(submissionDocuments)
    .innerJoin(documents, eq(documents.id, submissionDocuments.documentId))
    .where(eq(submissionDocuments.submissionId, sub.id));

  for (const dekId of new Set(values.map((v) => v.dekId))) await shredDataKey(dekId, tx);
  await tx.delete(submissionValues).where(eq(submissionValues.submissionId, sub.id));
  await tx.delete(submissionDocuments).where(eq(submissionDocuments.submissionId, sub.id));
  for (const d of docs) {
    if (d.dekId) await shredDataKey(d.dekId, tx);
    await enqueueDeletion(tx, d.storageKey, req?.orgId ?? null, erasureId);
    await tx.delete(documents).where(eq(documents.id, d.documentId));
  }
  // Consent evidence stays (notice version and time); the responder's network
  // address and contact details on the link and its deliveries do not.
  await tx.update(consents).set({ ip: null }).where(eq(consents.submissionId, sub.id));
  if (sub.accessTokenId) {
    await tx
      .update(accessTokens)
      .set({ recipientEmail: REDACTED, recipientPhone: null, otpHash: null })
      .where(eq(accessTokens.id, sub.accessTokenId));
    await tx
      .update(deliveries)
      .set({ recipient: REDACTED })
      .where(eq(deliveries.accessTokenId, sub.accessTokenId));
    await scrubAuditNetworkData(tx, "link_responder", sub.accessTokenId);
  }
  await tx
    .update(submissions)
    .set({ purgedAt: new Date(), responderEmail: null })
    .where(eq(submissions.id, sub.id));
  return { queued: docs.length, orgId: req?.orgId ?? null };
}

export async function purgeSubmission(submissionId: string, actor: Actor): Promise<void> {
  const outcome = await db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .for("update");
    if (!sub || sub.purgedAt) return null;
    const record = await openErasureRecord(tx, "submission", submissionId);
    const { queued, orgId } = await purgeSubmissionRows(tx, sub, record.id);
    const now = new Date();
    await tx
      .update(erasureRecords)
      .set({ accessRevokedAt: now, keysShreddedAt: now, cleanupPendingAt: now, objectsQueued: queued })
      .where(eq(erasureRecords.id, record.id));
    return { erasureId: record.id, orgId };
  });
  if (!outcome) return;

  await processDeletionTasks(deleteObject, 50, { erasureId: outcome.erasureId });
  await completeFinishedErasures();

  await audit({
    orgId: outcome.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "submission.purged",
    targetType: "submission",
    targetId: submissionId,
  });
}

/**
 * Select submission ids due for purge across all organisations, per each org's
 * retention policy. The scheduled job fans these out so a single poisoned
 * submission can't abort the rest of the run.
 *
 * - Default policy: submitted more than retentionDays ago.
 * - Purge on close: the role closed (or, without a close time, expired) more
 *   than retentionDays ago. Any submission, including one on a role
 *   that stays open, is capped at retentionDays + OPEN_ROLE_BACKSTOP_DAYS.
 * - Abandoned drafts: never submitted, and the link expired or was revoked, or
 *   the role was closed or archived.
 */
export async function findPurgeDueSubmissionIds(now = new Date()): Promise<string[]> {
  const orgs = await db.select().from(organisations);
  const ids: string[] = [];
  const receivedAt = sql`coalesce(${submissions.submittedAt}, ${submissions.createdAt})`;

  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.retentionDays * DAY_MS);
    const backstop = new Date(cutoff.getTime() - OPEN_ROLE_BACKSTOP_DAYS * DAY_MS);

    const due = await db
      .select({ id: submissions.id })
      .from(submissions)
      .innerJoin(requests, eq(requests.id, submissions.requestId))
      .where(
        and(
          eq(requests.orgId, org.id),
          isNull(submissions.purgedAt),
          org.purgeOnClose
            ? or(
                lt(requests.closedAt, cutoff),
                and(isNull(requests.closedAt), lt(requests.expiresAt, cutoff)),
                and(isNotNull(submissions.submittedAt), lt(receivedAt, backstop)),
              )
            : and(isNotNull(submissions.submittedAt), lt(submissions.submittedAt, cutoff)),
        ),
      );

    ids.push(...due.map((s) => s.id));
  }

  const staleDrafts = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(accessTokens, eq(accessTokens.id, submissions.accessTokenId))
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(
      and(
        eq(submissions.status, "started"),
        isNull(submissions.purgedAt),
        or(
          lt(accessTokens.expiresAt, now),
          isNotNull(accessTokens.revokedAt),
          inArray(requests.status, ["closed", "archived"]),
        ),
      ),
    );
  ids.push(...staleDrafts.map((s) => s.id));

  return [...new Set(ids)];
}

/** Enforce retention synchronously (used by tests / CLI). */
export async function runRetentionPurge(): Promise<number> {
  const ids = await findPurgeDueSubmissionIds();
  for (const id of ids) {
    await purgeSubmission(id, { actorType: "system" });
  }
  return ids.length;
}

/**
 * Delete one wallet document: shred its key, queue its object for durable
 * deletion, and drop the row in one transaction. Submissions that already
 * received a copy keep their own organisation-sealed envelope.
 */
export async function deleteWalletDocumentRecord(
  candidateAccountId: string,
  documentId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(walletDocuments)
      .where(
        and(
          eq(walletDocuments.id, documentId),
          eq(walletDocuments.candidateAccountId, candidateAccountId),
        ),
      )
      .for("update");
    if (!doc) return false;
    if (doc.dekId) await shredDataKey(doc.dekId, tx);
    await enqueueDeletion(tx, doc.storageKey, candidateAccountId);
    await tx.delete(walletDocuments).where(eq(walletDocuments.id, doc.id));
    return true;
  });
}

/** Sessions, credentials, passkeys, API keys, pending verifications, and identity. */
async function revokeAccess(tx: Tx, userId: string, candidateAccountId: string, now: Date) {
  await tx
    .update(candidateApiKeys)
    .set({ revokedAt: now, wrappedVaultKey: null })
    .where(and(eq(candidateApiKeys.candidateAccountId, candidateAccountId), isNull(candidateApiKeys.revokedAt)));
  // Deleting sessions also drops their vault unlocks (cascade).
  await tx.delete(session).where(eq(session.userId, userId));
  await tx.delete(account).where(eq(account.userId, userId));
  await tx.delete(passkey).where(eq(passkey.userId, userId));
  const [identity] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (identity) {
    await tx
      .delete(verification)
      .where(
        or(
          eq(verification.identifier, identity.email),
          sql`strpos(${verification.value}, ${identity.email}) > 0`,
          eq(verification.value, userId),
        ),
      );
  }
  // The row stays as a tombstone so the id can never sign in again (see the
  // session hook in lib/auth.ts). It keeps no name, email, or image.
  await tx
    .update(user)
    .set({
      erasedAt: now,
      updatedAt: now,
      name: "Deleted account",
      email: `erased+${userId}@erased.invalid`,
      emailVerified: false,
      image: null,
    })
    .where(eq(user.id, userId));
}

/**
 * Full job-seeker account deletion (APP 11.2). Three resumable steps:
 *
 * 1. Revoke access: API keys, sessions, credentials, passkeys, identity.
 * 2. Shred every data key (wallet, documents, vault, submissions), queue the
 *    storage objects, and delete the career record.
 * 3. Delete objects through the queue; the record reaches cleanup-finished
 *    when every queued object is gone.
 *
 * Safe to call again at any point. resumeIncompleteErasures() finishes runs
 * that stopped between steps.
 */
export async function eraseCandidate(
  candidateAccountId: string,
  hooks: { afterAccessRevoked?: () => Promise<void> } = {},
): Promise<{ erasureId: string } | null> {
  const record = await db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(candidateAccounts)
      .where(eq(candidateAccounts.id, candidateAccountId))
      .for("update");
    if (!owner) {
      const [existing] = await tx
        .select()
        .from(erasureRecords)
        .where(and(eq(erasureRecords.subjectType, "candidate"), eq(erasureRecords.subjectId, candidateAccountId)));
      return existing ?? null;
    }
    const row = await openErasureRecord(tx, "candidate", candidateAccountId);
    if (!row.accessRevokedAt) {
      const now = new Date();
      await revokeAccess(tx, owner.userId, candidateAccountId, now);
      await tx
        .update(erasureRecords)
        .set({ accessRevokedAt: now })
        .where(eq(erasureRecords.id, row.id));
    }
    return row;
  });
  if (!record) return null;

  await hooks.afterAccessRevoked?.();

  const purged = await db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(candidateAccounts)
      .where(eq(candidateAccounts.id, candidateAccountId))
      .for("update");
    if (!owner) return null;

    const items = await tx
      .select({ dekId: walletItems.dekId })
      .from(walletItems)
      .where(eq(walletItems.candidateAccountId, candidateAccountId));
    const docs = await tx
      .select()
      .from(walletDocuments)
      .where(eq(walletDocuments.candidateAccountId, candidateAccountId));
    const subs = await tx
      .select({
        id: submissions.id,
        requestId: submissions.requestId,
        accessTokenId: submissions.accessTokenId,
      })
      .from(submissions)
      .where(and(eq(submissions.candidateAccountId, candidateAccountId), isNull(submissions.purgedAt)));

    for (const item of items) await shredDataKey(item.dekId, tx);
    for (const doc of docs) {
      if (doc.dekId) await shredDataKey(doc.dekId, tx);
      await enqueueDeletion(tx, doc.storageKey, candidateAccountId, record.id);
    }
    let queued = docs.length;
    const purged: { id: string; orgId: string | null }[] = [];
    for (const sub of subs) {
      const result = await purgeSubmissionRows(tx, sub, record.id);
      queued += result.queued;
      purged.push({ id: sub.id, orgId: result.orgId });
    }

    const now = new Date();
    await tx
      .update(vaultKeys)
      .set({ privateKeyWrapped: null, status: "shredded", retiredAt: now })
      .where(and(eq(vaultKeys.ownerType, "candidate"), eq(vaultKeys.ownerId, candidateAccountId)));
    await tx.delete(walletShares).where(eq(walletShares.candidateAccountId, candidateAccountId));
    await tx.delete(walletItems).where(eq(walletItems.candidateAccountId, candidateAccountId));
    await tx.delete(walletDocuments).where(eq(walletDocuments.candidateAccountId, candidateAccountId));
    await tx.delete(savedRoles).where(eq(savedRoles.candidateAccountId, candidateAccountId));
    await scrubAuditNetworkData(tx, "candidate", candidateAccountId);
    // Cascades to the discovery profile, alert preferences, match ledger, and
    // the (already revoked) API keys.
    await tx.delete(candidateAccounts).where(eq(candidateAccounts.id, candidateAccountId));
    await tx
      .update(erasureRecords)
      .set({ keysShreddedAt: now, cleanupPendingAt: now, objectsQueued: queued })
      .where(eq(erasureRecords.id, record.id));
    return purged;
  });

  await processDeletionTasks(deleteObject, 50, { erasureId: record.id });
  await completeFinishedErasures();

  if (purged) {
    for (const sub of purged) {
      await audit({
        orgId: sub.orgId,
        actorType: "candidate",
        actorId: candidateAccountId,
        action: "submission.purged",
        targetType: "submission",
        targetId: sub.id,
      });
    }
    await audit({
      actorType: "candidate",
      actorId: candidateAccountId,
      action: "candidate.erased",
      targetType: "candidate_account",
      targetId: candidateAccountId,
    });
  }
  return { erasureId: record.id };
}

/** Finish erasures that stopped after access was revoked but before keys were shredded. */
export async function resumeIncompleteErasures(): Promise<number> {
  const stalled = await db
    .select({ subjectId: erasureRecords.subjectId })
    .from(erasureRecords)
    .where(and(eq(erasureRecords.subjectType, "candidate"), isNull(erasureRecords.keysShreddedAt)));
  for (const row of stalled) await eraseCandidate(row.subjectId);
  return stalled.length;
}
