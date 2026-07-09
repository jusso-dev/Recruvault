import "server-only";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  documents,
  organisations,
  requests,
  submissionDocuments,
  submissions,
  submissionValues,
  walletDocuments,
  walletItems,
  walletShares,
  savedRoles,
  candidateAccounts,
} from "@/db/schema";
import { shredDataKey } from "@/lib/crypto";
import { deleteObject } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { getLogger } from "@/lib/logger";

const log = getLogger("retention");

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
    for (const d of docs) await tx.delete(documents).where(eq(documents.id, d.documentId));
    await tx
      .update(submissions)
      .set({ purgedAt: new Date(), responderEmail: null })
      .where(eq(submissions.id, submissionId));
  });

  for (const d of docs) {
    try {
      await deleteObject(d.storageKey);
    } catch (err) {
      log.error({ storageKey: d.storageKey, err }, "storage object delete failed");
    }
  }

  await audit({
    orgId: req?.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "submission.purged",
    targetType: "submission",
    targetId: submissionId,
  });
}

/** Scheduled purge: enforce each organisation's retention policy. */
export async function runRetentionPurge(): Promise<number> {
  let purged = 0;
  const orgs = await db.select().from(organisations);

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

    for (const s of due) {
      await purgeSubmission(s.id, { actorType: "system" });
      purged++;
    }
  }
  return purged;
}

/**
 * Job seeker erasure (APP 11.2): crypto-shred the wallet, delete wallet
 * documents, and purge every submission tied to the account.
 */
export async function eraseCandidate(candidateAccountId: string): Promise<void> {
  const items = await db
    .select()
    .from(walletItems)
    .where(eq(walletItems.candidateAccountId, candidateAccountId));
  const docs = await db
    .select()
    .from(walletDocuments)
    .where(eq(walletDocuments.candidateAccountId, candidateAccountId));

  // Shred wallet DEKs and drop the rows atomically; delete objects after commit.
  await db.transaction(async (tx) => {
    for (const item of items) await shredDataKey(item.dekId, tx);
    await tx.delete(walletItems).where(eq(walletItems.candidateAccountId, candidateAccountId));
    await tx
      .delete(walletDocuments)
      .where(eq(walletDocuments.candidateAccountId, candidateAccountId));
  });

  for (const doc of docs) {
    try {
      await deleteObject(doc.storageKey);
    } catch (err) {
      log.error({ storageKey: doc.storageKey, err }, "storage object delete failed");
    }
  }

  const subs = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.candidateAccountId, candidateAccountId));
  for (const s of subs) {
    await purgeSubmission(s.id, { actorType: "candidate", actorId: candidateAccountId });
  }

  await db.delete(walletShares).where(eq(walletShares.candidateAccountId, candidateAccountId));
  await db.delete(savedRoles).where(eq(savedRoles.candidateAccountId, candidateAccountId));
  await db.delete(candidateAccounts).where(eq(candidateAccounts.id, candidateAccountId));

  await audit({
    actorType: "candidate",
    actorId: candidateAccountId,
    action: "candidate.erased",
    targetType: "candidate_account",
    targetId: candidateAccountId,
  });
}
