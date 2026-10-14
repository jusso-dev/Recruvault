import "server-only";
import { and, count, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys, requests, submissions, submissionValues, vaultKeys, walletItems } from "@/db/schema";
import { unwrapLegacyDek } from "@/lib/crypto-legacy";
import { fieldAad, openCrkWrap, verifierMatches, wrapWithCrk } from "@/lib/vault-crypto";
import { lockVaultOwner } from "@/lib/vault-store";
import type { VaultOwner } from "@/lib/key-rotation";

const BATCH = 100;

const legacyWrap = and(
  or(eq(dataKeys.wrapMode, "legacy"), eq(dataKeys.keySource, "local")),
  isNull(dataKeys.shreddedAt),
  isNotNull(dataKeys.wrappedKey),
);

/**
 * Legacy LOCAL_KEK field keys owned by this vault, with the purpose they are
 * migrated under. Seeker wallet values belong to the candidate; submitted
 * answers belong to the organisation that requested them. Open drafts stay
 * legacy because the link responder still has to read them. Document keys are
 * migrated with their objects (see document migration), not here.
 */
async function legacyRows(executor: Pick<typeof db, "select">, owner: VaultOwner, limit: number) {
  if (owner.ownerType === "candidate") {
    return executor
      .select({ id: dataKeys.id, wrappedKey: dataKeys.wrappedKey, purpose: walletItems.type })
      .from(walletItems)
      .innerJoin(dataKeys, eq(dataKeys.id, walletItems.dekId))
      .where(and(eq(walletItems.candidateAccountId, owner.ownerId), legacyWrap))
      .limit(limit);
  }
  return executor
    .select({ id: dataKeys.id, wrappedKey: dataKeys.wrappedKey, purpose: submissionValues.fieldId })
    .from(submissionValues)
    .innerJoin(submissions, eq(submissions.id, submissionValues.submissionId))
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .innerJoin(dataKeys, eq(dataKeys.id, submissionValues.dekId))
    .where(and(eq(requests.orgId, owner.ownerId), ne(submissions.status, "started"), legacyWrap))
    .limit(limit);
}

export async function countLegacyDataKeys(owner: VaultOwner): Promise<number> {
  if (owner.ownerType === "candidate") {
    const [row] = await db
      .select({ n: count() })
      .from(walletItems)
      .innerJoin(dataKeys, eq(dataKeys.id, walletItems.dekId))
      .where(and(eq(walletItems.candidateAccountId, owner.ownerId), legacyWrap));
    return row.n;
  }
  const [row] = await db
    .select({ n: count() })
    .from(submissionValues)
    .innerJoin(submissions, eq(submissions.id, submissionValues.submissionId))
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .innerJoin(dataKeys, eq(dataKeys.id, submissionValues.dekId))
    .where(and(eq(requests.orgId, owner.ownerId), ne(submissions.status, "started"), legacyWrap));
  return row.n;
}

/**
 * Rewrap legacy LOCAL_KEK data keys under the owner's customer key, in place.
 * The DEK and ciphertext do not change, so the record stays readable at every
 * step: unmigrated rows still open with LOCAL_KEK, migrated rows with the
 * customer key. Each batch is verified and committed on its own, so the run is
 * resumable and safe to repeat. Returns counts only.
 */
export async function migrateLegacyDataKeys(
  input: VaultOwner & { crk: Buffer },
  options: { batchSize?: number; maxBatches?: number; onBatch?: (migrated: number) => Promise<void> | void } = {},
): Promise<{ migrated: number; remaining: number }> {
  const owner = { ownerType: input.ownerType, ownerId: input.ownerId };
  const batchSize = options.batchSize ?? BATCH;
  const maxBatches = options.maxBatches ?? 1_000;
  let migrated = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const moved = await db.transaction(async (tx) => {
      await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
      const [vault] = await tx
        .select()
        .from(vaultKeys)
        .where(
          and(
            eq(vaultKeys.ownerType, owner.ownerType),
            eq(vaultKeys.ownerId, owner.ownerId),
            eq(vaultKeys.status, "active"),
          ),
        );
      if (!vault || !verifierMatches(input.crk, owner.ownerType, owner.ownerId, vault.verifier)) {
        throw new Error("The encryption key does not match this vault.");
      }
      const rows = await legacyRows(tx, owner, batchSize);
      if (rows.length === 0) return 0;
      // Row locks so a concurrent shred or second migrator cannot interleave.
      await tx
        .select({ id: dataKeys.id })
        .from(dataKeys)
        .where(inArray(dataKeys.id, rows.map((row) => row.id)))
        .for("update");
      for (const row of rows) {
        if (!row.wrappedKey) continue;
        const dek = unwrapLegacyDek(row.wrappedKey);
        const purpose = owner.ownerType === "candidate" ? row.purpose : "submission";
        const aad = fieldAad(owner.ownerType, owner.ownerId, row.id, purpose, vault.version);
        const wrapped = wrapWithCrk(input.crk, dek, aad);
        if (!openCrkWrap(input.crk, wrapped, aad).equals(dek)) throw new Error("A migrated key did not verify.");
        await tx
          .update(dataKeys)
          .set({
            wrappedKey: wrapped,
            keySource: "customer",
            wrapMode: "crk",
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            purpose,
            keyVersion: vault.version,
            aad,
          })
          .where(and(eq(dataKeys.id, row.id), isNull(dataKeys.shreddedAt), eq(dataKeys.keySource, "local")));
      }
      await options.onBatch?.(rows.length);
      return rows.length;
    });
    migrated += moved;
    if (moved < batchSize) break;
  }
  return { migrated, remaining: await countLegacyDataKeys(owner) };
}
