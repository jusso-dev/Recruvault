import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys, vaultKeys, vaultRotations } from "@/db/schema";
import {
  customerKeyVerifier,
  fieldAad,
  generateRecipientKeyPair,
  openCrkWrap,
  openSeal,
  privateKeyAad,
  sealToPublicKey,
  verifierMatches,
  wrapWithCrk,
} from "@/lib/vault-crypto";

const BATCH = 50;

/**
 * Rewrap every customer DEK from one vault version to the next. The caller
 * must present both keys. Interrupted runs resume: rows already on the new
 * version are skipped, and the active pointer flips only after the batch is
 * empty. Legacy LOCAL_KEK rows are not rotated here.
 */
export async function rotateVaultKey(input: {
  ownerType: "organisation" | "candidate";
  ownerId: string;
  oldCrk: Buffer;
  newCrk: Buffer;
  kdf?: "scrypt" | null;
  kdfSalt?: string | null;
  kdfParams?: { N: number; r: number; p: number; version: number } | null;
}): Promise<{ fromVersion: number; toVersion: number; rotated: number; completed: boolean }> {
  const current = await db
    .select()
    .from(vaultKeys)
    .where(
      and(
        eq(vaultKeys.ownerType, input.ownerType),
        eq(vaultKeys.ownerId, input.ownerId),
        eq(vaultKeys.status, "active"),
      ),
    );
  const active = current[0];
  if (!active?.privateKeyWrapped) throw new Error("No active encryption key.");
  if (!verifierMatches(input.oldCrk, input.ownerType, input.ownerId, active.verifier)) {
    throw new Error("The current encryption key does not match.");
  }

  let pending = (
    await db
      .select()
      .from(vaultKeys)
      .where(
        and(
          eq(vaultKeys.ownerType, input.ownerType),
          eq(vaultKeys.ownerId, input.ownerId),
          eq(vaultKeys.status, "pending"),
        ),
      )
  )[0];

  if (pending && !verifierMatches(input.newCrk, input.ownerType, input.ownerId, pending.verifier)) {
    throw new Error("A rotation is already in progress with a different key.");
  }

  if (!pending) {
    const version = active.version + 1;
    const pair = generateRecipientKeyPair();
    const [created] = await db
      .insert(vaultKeys)
      .values({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        version,
        status: "pending",
        verifier: customerKeyVerifier(input.newCrk, input.ownerType, input.ownerId),
        publicKey: pair.publicKey,
        privateKeyWrapped: wrapWithCrk(
          input.newCrk,
          Buffer.from(pair.privateKey, "utf8"),
          privateKeyAad(input.ownerType, input.ownerId, version),
        ),
        kdf: input.kdf ?? null,
        kdfSalt: input.kdfSalt ?? null,
        kdfParams: input.kdfParams ?? null,
      })
      .returning();
    pending = created;
    await db.insert(vaultRotations).values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      fromVersion: active.version,
      toVersion: version,
      state: "pending",
    });
  }

  const oldPrivate = openCrkWrap(
    input.oldCrk,
    active.privateKeyWrapped,
    privateKeyAad(input.ownerType, input.ownerId, active.version),
  ).toString("utf8");

  const rows = await db
    .select()
    .from(dataKeys)
    .where(
      and(
        eq(dataKeys.ownerType, input.ownerType),
        eq(dataKeys.ownerId, input.ownerId),
        eq(dataKeys.keyVersion, active.version),
        eq(dataKeys.keySource, "customer"),
        isNull(dataKeys.shreddedAt),
      ),
    )
    .limit(BATCH);

  let rotated = 0;
  for (const row of rows) {
    if (!row.wrappedKey || row.shreddedAt) continue;
    const dek =
      row.wrapMode === "sealed"
        ? openSeal(oldPrivate, active.publicKey, row.wrappedKey, row.aad ?? "")
        : openCrkWrap(input.oldCrk, row.wrappedKey, row.aad ?? "");
    const aad = fieldAad(input.ownerType, input.ownerId, row.id, row.purpose ?? "field", pending.version);
    const wrapped =
      row.wrapMode === "sealed"
        ? sealToPublicKey(pending.publicKey, dek, aad)
        : wrapWithCrk(input.newCrk, dek, aad);
    await db
      .update(dataKeys)
      .set({ wrappedKey: wrapped, keyVersion: pending.version, aad, purpose: row.purpose ?? "field" })
      .where(and(eq(dataKeys.id, row.id), eq(dataKeys.keyVersion, active.version)));
    rotated += 1;
  }

  const [remaining] = await db
    .select({ id: dataKeys.id })
    .from(dataKeys)
    .where(
      and(
        eq(dataKeys.ownerType, input.ownerType),
        eq(dataKeys.ownerId, input.ownerId),
        eq(dataKeys.keyVersion, active.version),
        eq(dataKeys.keySource, "customer"),
        isNull(dataKeys.shreddedAt),
      ),
    )
    .limit(1);

  if (!remaining) {
    await db.transaction(async (tx) => {
      await tx
        .update(vaultKeys)
        .set({ status: "retired", retiredAt: new Date() })
        .where(eq(vaultKeys.id, active.id));
      await tx.update(vaultKeys).set({ status: "active" }).where(eq(vaultKeys.id, pending.id));
      await tx
        .update(vaultRotations)
        .set({ state: "complete", completedAt: new Date(), rotatedCount: rotated })
        .where(
          and(
            eq(vaultRotations.ownerType, input.ownerType),
            eq(vaultRotations.ownerId, input.ownerId),
            eq(vaultRotations.toVersion, pending.version),
          ),
        );
    });
  }

  return {
    fromVersion: active.version,
    toVersion: pending.version,
    rotated,
    completed: !remaining,
  };
}
