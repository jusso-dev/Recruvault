import "server-only";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  candidateApiKeys,
  documents,
  erasureRecords,
  organisations,
  requests,
  session,
  submissionDocuments,
  submissions,
  submissionValues,
  user,
  vaultKeys,
  walletDocuments,
  walletItems,
  walletShares,
  savedRoles,
  candidateAccounts,
} from "@/db/schema";
import { shredDataKey } from "@/lib/crypto";
import { enqueueDeletion, processDeletionTasks } from "@/lib/deletion-queue";
import { audit } from "@/lib/audit";

/**
 * Retention and deletion.
 *
 * Deletion is a crypto-shred: destroy the record's data encryption keys so
 * the ciphertext is unrecoverable, then remove the rows and storage objects.
 * The submission row survives with purgedAt set so the audit trail keeps a
 * metadata-only record of handling after the PII is gone.
 */

export async function purgeSubmission(
  submissionId: string,
  actor: { actorType: "system" | "org_user" | "candidate"; actorId?: string },
): Promise<void> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
  if (!sub || sub.purgedAt) return;

  const [req] = await db.select().from(requests).where(eq(requests.id, sub.requestId));

  const values = await db
    .select({ dekId: submissionValues.dekId })
    .from(submissionValues)
    .where(eq(submissionValues.submissionId, submissionId));
  const docs = await db
    .select({ documentId: submissionDocuments.documentId, storageKey: documents.storageKey })
    .from(submissionDocuments)
    .innerJoin(documents, eq(documents.id, submissionDocuments.documentId))
    .where(eq(submissionDocuments.submissionId, submissionId));

  // Shred DEKs, drop ciphertext rows, and tombstone the submission atomically:
  // either the whole crypto-shred lands or none of it does. Storage-object
  // deletion (external) runs after the DB commit.
  await db.transaction(async (tx) => {
    for (const v of values) await shredDataKey(v.dekId, tx);
    await tx.delete(submissionValues).where(eq(submissionValues.submissionId, submissionId));
    await tx.delete(submissionDocuments).where(eq(submissionDocuments.submissionId, submissionId));
    for (const d of docs) {
      await enqueueDeletion(tx, d.storageKey, req?.orgId ?? null);
      await tx.delete(documents).where(eq(documents.id, d.documentId));
    }
    await tx
      .update(submissions)
      .set({ purgedAt: new Date(), responderEmail: null })
      .where(eq(submissions.id, submissionId));
  });

  await processDeletionTasks();

  await audit({
    orgId: req?.orgId,
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
 */
export async function findPurgeDueSubmissionIds(): Promise<string[]> {
  const orgs = await db.select().from(organisations);
  const ids: string[] = [];

  for (const org of orgs) {
    const cutoff = new Date(Date.now() - org.retentionDays * 24 * 60 * 60 * 1000);

    const due = await db
      .select({ id: submissions.id })
      .from(submissions)
      .innerJoin(requests, eq(requests.id, submissions.requestId))
      .where(
        and(
          eq(requests.orgId, org.id),
          isNull(submissions.purgedAt),
          org.purgeOnClose
            ? and(sql`${requests.closedAt} IS NOT NULL`, lt(requests.closedAt, cutoff))
            : lt(submissions.submittedAt, cutoff),
        ),
      );

    ids.push(...due.map((s) => s.id));
  }

  // Abandoned drafts: "started" submissions whose secure link has expired and
  // will never be submitted. Crypto-shred them like any other stale PII.
  const staleDrafts = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(accessTokens, eq(accessTokens.id, submissions.accessTokenId))
    .where(
      and(
        eq(submissions.status, "started"),
        isNull(submissions.purgedAt),
        lt(accessTokens.expiresAt, new Date()),
      ),
    );
  ids.push(...staleDrafts.map((s) => s.id));

  return ids;
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
 * Job seeker erasure (APP 11.2): crypto-shred the wallet, delete wallet
 * documents, and purge every submission tied to the account.
 */
export async function eraseCandidate(candidateAccountId: string): Promise<void> {
  const [account] = await db
    .select()
    .from(candidateAccounts)
    .where(eq(candidateAccounts.id, candidateAccountId));
  if (!account) return;

  const items = await db
    .select()
    .from(walletItems)
    .where(eq(walletItems.candidateAccountId, candidateAccountId));
  const docs = await db
    .select()
    .from(walletDocuments)
    .where(eq(walletDocuments.candidateAccountId, candidateAccountId));
  const subs = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.candidateAccountId, candidateAccountId));

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const item of items) await shredDataKey(item.dekId, tx);
    for (const doc of docs) {
      if (doc.dekId) await shredDataKey(doc.dekId, tx);
      await enqueueDeletion(tx, doc.storageKey, candidateAccountId);
    }
    await tx.delete(walletItems).where(eq(walletItems.candidateAccountId, candidateAccountId));
    await tx.delete(walletDocuments).where(eq(walletDocuments.candidateAccountId, candidateAccountId));
    await tx
      .update(candidateApiKeys)
      .set({ revokedAt: now, wrappedVaultKey: null })
      .where(eq(candidateApiKeys.candidateAccountId, candidateAccountId));
    await tx.delete(session).where(eq(session.userId, account.userId));
    await tx
      .update(vaultKeys)
      .set({ privateKeyWrapped: null, status: "shredded", retiredAt: now })
      .where(and(eq(vaultKeys.ownerType, "candidate"), eq(vaultKeys.ownerId, candidateAccountId)));
    await tx.update(user).set({ erasedAt: now, updatedAt: now }).where(eq(user.id, account.userId));
    await tx.insert(erasureRecords).values({
      subjectType: "candidate",
      subjectId: candidateAccountId,
      accessRevokedAt: now,
      keysShreddedAt: now,
      cleanupPendingAt: now,
    });
  });

  for (const s of subs) {
    await purgeSubmission(s.id, { actorType: "candidate", actorId: candidateAccountId });
  }

  await db.delete(walletShares).where(eq(walletShares.candidateAccountId, candidateAccountId));
  await db.delete(savedRoles).where(eq(savedRoles.candidateAccountId, candidateAccountId));
  await db.delete(candidateAccounts).where(eq(candidateAccounts.id, candidateAccountId));
  await processDeletionTasks();

  const pending = docs.length + subs.length;
  if (pending === 0) {
    await db
      .update(erasureRecords)
      .set({ cleanupFinishedAt: new Date() })
      .where(eq(erasureRecords.subjectId, candidateAccountId));
  }

  await audit({
    actorType: "candidate",
    actorId: candidateAccountId,
    action: "candidate.erased",
    targetType: "candidate_account",
    targetId: candidateAccountId,
  });
}
