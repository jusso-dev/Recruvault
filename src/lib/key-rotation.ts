import "server-only";
import { randomUUID } from "crypto";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, candidateApiKeys, dataKeys, vaultKeys, vaultRotations, vaultUnlocks } from "@/db/schema";
import {
  fieldAad,
  openCrkWrap,
  openSeal,
  privateKeyAad,
  sealToPublicKey,
  VaultCryptoError,
  verifierMatches,
  wrapWithCrk,
  type KdfParams,
} from "@/lib/vault-crypto";
import {
  bridgeAad,
  insertVaultKey,
  lockVaultOwner,
  openOwnerWrap,
  ROTATION_BRIDGE_PURPOSE,
} from "@/lib/vault-store";

const BATCH = 50;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type VaultKeyRow = typeof vaultKeys.$inferSelect;
type DataKeyRow = typeof dataKeys.$inferSelect;

export interface VaultOwner {
  ownerType: "organisation" | "candidate";
  ownerId: string;
}

export interface RotationOptions {
  batchSize?: number;
  /** Stop after this many batches; the next call resumes. */
  maxBatches?: number;
  /** Runs inside each batch transaction before commit. Tests use it to simulate a crash. */
  onBatch?: (rewrapped: number) => Promise<void> | void;
}

export interface RotationResult {
  fromVersion: number;
  toVersion: number;
  rotated: number;
  completed: boolean;
  revokedApiKeys: number;
}

export class RotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationError";
  }
}

async function vaultRows(tx: Tx, owner: VaultOwner) {
  const rows = await tx
    .select()
    .from(vaultKeys)
    .where(and(eq(vaultKeys.ownerType, owner.ownerType), eq(vaultKeys.ownerId, owner.ownerId)));
  return {
    active: rows.find((row) => row.status === "active"),
    pending: rows.find((row) => row.status === "pending"),
  };
}

/** Customer-wrapped data keys still on `version`. The rotation bridge is not a record. */
function ownedAtVersion(owner: VaultOwner, version: number) {
  return and(
    eq(dataKeys.ownerType, owner.ownerType),
    eq(dataKeys.ownerId, owner.ownerId),
    eq(dataKeys.keyVersion, version),
    eq(dataKeys.keySource, "customer"),
    inArray(dataKeys.wrapMode, ["crk", "sealed"]),
    isNull(dataKeys.shreddedAt),
    sql`${dataKeys.purpose} is distinct from ${ROTATION_BRIDGE_PURPOSE}`,
  );
}

function bridgeRows(owner: VaultOwner) {
  return and(
    eq(dataKeys.ownerType, owner.ownerType),
    eq(dataKeys.ownerId, owner.ownerId),
    eq(dataKeys.purpose, ROTATION_BRIDGE_PURPOSE),
  );
}

function rotationRow(owner: VaultOwner, toVersion: number) {
  return and(
    eq(vaultRotations.ownerType, owner.ownerType),
    eq(vaultRotations.ownerId, owner.ownerId),
    eq(vaultRotations.toVersion, toVersion),
  );
}

/**
 * Rewrap one data key from `from` to `to` and prove the new envelope opens to
 * the same key before it is written.
 */
function rewrap(
  owner: VaultOwner,
  row: DataKeyRow,
  from: { vault: VaultKeyRow; crk: Buffer },
  to: { vault: VaultKeyRow; crk: Buffer; privateKey: () => string },
) {
  const dek = openOwnerWrap(row, from.vault, from.crk);
  const aad = fieldAad(owner.ownerType, owner.ownerId, row.id, row.purpose ?? "", to.vault.version);
  const wrapped =
    row.wrapMode === "sealed" ? sealToPublicKey(to.vault.publicKey, dek, aad) : wrapWithCrk(to.crk, dek, aad);
  const check =
    row.wrapMode === "sealed"
      ? openSeal(to.privateKey(), to.vault.publicKey, wrapped, aad)
      : openCrkWrap(to.crk, wrapped, aad);
  if (!check.equals(dek)) throw new RotationError("A rewrapped key did not verify.");
  return { wrappedKey: wrapped, keyVersion: to.vault.version, aad };
}

function privateKeyOf(vault: VaultKeyRow, crk: Buffer) {
  let cached: string | undefined;
  return () => {
    if (!vault.privateKeyWrapped) throw new VaultCryptoError("Vault is locked.");
    cached ??= openCrkWrap(
      crk,
      vault.privateKeyWrapped,
      privateKeyAad(vault.ownerType, vault.ownerId, vault.version),
    ).toString("utf8");
    return cached;
  };
}

async function startRotation(
  owner: VaultOwner,
  input: { oldCrk: Buffer; newCrk: Buffer; kdf?: "scrypt" | null; kdfSalt?: string | null; kdfParams?: KdfParams | null },
) {
  return db.transaction(async (tx) => {
    await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
    const { active, pending } = await vaultRows(tx, owner);
    if (!active?.privateKeyWrapped) throw new RotationError("No active encryption key.");
    if (!verifierMatches(input.oldCrk, owner.ownerType, owner.ownerId, active.verifier)) {
      throw new RotationError("The current encryption key does not match.");
    }
    if (verifierMatches(input.newCrk, owner.ownerType, owner.ownerId, active.verifier)) {
      throw new RotationError("Choose a new encryption key that differs from the current one.");
    }
    if (pending) {
      if (!verifierMatches(input.newCrk, owner.ownerType, owner.ownerId, pending.verifier)) {
        throw new RotationError("A rotation is already in progress with a different key.");
      }
      const [record] = await tx.select().from(vaultRotations).where(rotationRow(owner, pending.version));
      if (record?.state === "cancelling") throw new RotationError("This rotation is being cancelled.");
      return { active, pending };
    }
    const created = await insertVaultKey(tx, {
      ...owner,
      crk: input.newCrk,
      version: active.version + 1,
      status: "pending",
      kdf: input.kdf ?? null,
      kdfSalt: input.kdfSalt ?? null,
      kdfParams: input.kdfParams ?? null,
    });
    const bridgeId = randomUUID();
    const aad = bridgeAad(owner.ownerType, owner.ownerId, bridgeId, active.version);
    await tx.insert(dataKeys).values({
      id: bridgeId,
      wrappedKey: wrapWithCrk(input.oldCrk, input.newCrk, aad),
      keySource: "customer",
      wrapMode: "crk",
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      purpose: ROTATION_BRIDGE_PURPOSE,
      keyVersion: active.version,
      aad,
    });
    await tx.insert(vaultRotations).values({
      ...owner,
      fromVersion: active.version,
      toVersion: created.version,
      state: "running",
    });
    return { active, pending: created };
  });
}

async function rotateBatch(
  owner: VaultOwner,
  keys: { oldCrk: Buffer; newCrk: Buffer },
  batchSize: number,
  onBatch?: RotationOptions["onBatch"],
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
    const { active, pending } = await vaultRows(tx, owner);
    if (!active || !pending) return 0;
    const rows = await tx
      .select()
      .from(dataKeys)
      .where(ownedAtVersion(owner, active.version))
      .limit(batchSize)
      .for("update");
    const to = { vault: pending, crk: keys.newCrk, privateKey: privateKeyOf(pending, keys.newCrk) };
    for (const row of rows) {
      const next = rewrap(owner, row, { vault: active, crk: keys.oldCrk }, to);
      await tx
        .update(dataKeys)
        .set(next)
        .where(and(eq(dataKeys.id, row.id), eq(dataKeys.keyVersion, active.version)));
    }
    if (rows.length > 0) {
      await tx
        .update(vaultRotations)
        .set({ rotatedCount: sql`${vaultRotations.rotatedCount} + ${rows.length}` })
        .where(rotationRow(owner, pending.version));
    }
    await onBatch?.(rows.length);
    return rows.length;
  });
}

/**
 * Flip the active pointer once no record is left on the old version. The row
 * lock on the active vault key waits for in-flight writers (which take a share
 * lock on it when inserting a data key) and makes later writers fail instead
 * of landing on the retired version.
 */
async function trySwitch(
  owner: VaultOwner,
  newCrk: Buffer,
): Promise<{ switched: boolean; revokedApiKeys: number }> {
  return db.transaction(async (tx) => {
    await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
    const { active, pending } = await vaultRows(tx, owner);
    if (!active) throw new RotationError("No active encryption key.");
    if (!pending) {
      // Another worker finished first, or the rotation was cancelled.
      if (verifierMatches(newCrk, owner.ownerType, owner.ownerId, active.verifier)) {
        return { switched: true, revokedApiKeys: 0 };
      }
      throw new RotationError("The rotation was cancelled.");
    }
    await tx.select({ id: vaultKeys.id }).from(vaultKeys).where(eq(vaultKeys.id, active.id)).for("update");
    const [left] = await tx.select({ n: count() }).from(dataKeys).where(ownedAtVersion(owner, active.version));
    if (left.n > 0) return { switched: false, revokedApiKeys: 0 };

    // Completion check passed: the retired private key is no longer needed by
    // live data. Older backups keep their own copy (see docs/operations.md).
    await tx
      .update(vaultKeys)
      .set({ status: "retired", retiredAt: new Date(), privateKeyWrapped: null })
      .where(eq(vaultKeys.id, active.id));
    await tx.update(vaultKeys).set({ status: "active" }).where(eq(vaultKeys.id, pending.id));
    await tx.delete(dataKeys).where(bridgeRows(owner));
    await tx.delete(vaultUnlocks).where(eq(vaultUnlocks.vaultKeyId, active.id));
    // API keys carry a delegation of the retired key and cannot be rewrapped
    // without their secret, so they are revoked and must be re-issued.
    const keyTable = owner.ownerType === "organisation" ? apiKeys : candidateApiKeys;
    const revoked = await tx
      .update(keyTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(keyTable.vaultKeyId, active.id), isNull(keyTable.revokedAt)))
      .returning({ id: keyTable.id });
    await tx
      .update(vaultRotations)
      .set({ state: "complete", completedAt: new Date() })
      .where(rotationRow(owner, pending.version));
    return { switched: true, revokedApiKeys: revoked.length };
  });
}

/**
 * Rewrap every customer DEK from the active vault version to a new one. The
 * caller presents both keys. Each batch commits on its own, so an interrupted
 * run resumes where it stopped; the active pointer flips only after a locked
 * re-count finds nothing left. While a rotation is pending, the new key is
 * reachable from the active key through a bridge wrap so other sessions keep
 * reading rewrapped records. Legacy LOCAL_KEK rows are migrated separately.
 */
export async function rotateVaultKey(
  input: VaultOwner & {
    oldCrk: Buffer;
    newCrk: Buffer;
    kdf?: "scrypt" | null;
    kdfSalt?: string | null;
    kdfParams?: KdfParams | null;
  },
  options: RotationOptions = {},
): Promise<RotationResult> {
  const owner = { ownerType: input.ownerType, ownerId: input.ownerId };
  const { active, pending } = await startRotation(owner, input);
  const batchSize = options.batchSize ?? BATCH;
  const maxBatches = options.maxBatches ?? 10_000;
  let rotated = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const done = await rotateBatch(owner, input, batchSize, options.onBatch);
    rotated += done;
    if (done > 0) continue;
    const result = await trySwitch(owner, input.newCrk);
    if (result.switched) {
      return {
        fromVersion: active.version,
        toVersion: pending.version,
        rotated,
        completed: true,
        revokedApiKeys: result.revokedApiKeys,
      };
    }
  }
  return { fromVersion: active.version, toVersion: pending.version, rotated, completed: false, revokedApiKeys: 0 };
}

/**
 * Abandon a pending rotation using only the active key: the bridge recovers
 * the pending key, every record already moved is rewrapped back, and the
 * pending key is deleted. This is the rollback path when the new key is lost.
 */
export async function cancelVaultRotation(
  input: VaultOwner & { crk: Buffer },
  options: Pick<RotationOptions, "batchSize"> = {},
): Promise<{ restored: number; cancelled: boolean }> {
  const owner = { ownerType: input.ownerType, ownerId: input.ownerId };
  const batchSize = options.batchSize ?? BATCH;
  const newCrk = await db.transaction(async (tx) => {
    await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
    const { active, pending } = await vaultRows(tx, owner);
    if (!active || !pending) return undefined;
    if (!verifierMatches(input.crk, owner.ownerType, owner.ownerId, active.verifier)) {
      throw new RotationError("The current encryption key does not match.");
    }
    const [bridge] = await tx.select().from(dataKeys).where(bridgeRows(owner));
    if (!bridge?.wrappedKey) throw new RotationError("The rotation bridge is missing; cancellation is unsafe.");
    const recovered = openCrkWrap(
      input.crk,
      bridge.wrappedKey,
      bridgeAad(owner.ownerType, owner.ownerId, bridge.id, active.version),
    );
    if (!verifierMatches(recovered, owner.ownerType, owner.ownerId, pending.verifier)) {
      throw new RotationError("The rotation bridge does not match the pending key.");
    }
    await tx.update(vaultRotations).set({ state: "cancelling" }).where(rotationRow(owner, pending.version));
    return recovered;
  });
  if (!newCrk) return { restored: 0, cancelled: false };

  let restored = 0;
  for (;;) {
    const moved = await db.transaction(async (tx) => {
      await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
      const { active, pending } = await vaultRows(tx, owner);
      if (!active || !pending) return 0;
      const rows = await tx
        .select()
        .from(dataKeys)
        .where(ownedAtVersion(owner, pending.version))
        .limit(batchSize)
        .for("update");
      const to = { vault: active, crk: input.crk, privateKey: privateKeyOf(active, input.crk) };
      for (const row of rows) {
        const next = rewrap(owner, row, { vault: pending, crk: newCrk }, to);
        await tx
          .update(dataKeys)
          .set(next)
          .where(and(eq(dataKeys.id, row.id), eq(dataKeys.keyVersion, pending.version)));
      }
      return rows.length;
    });
    restored += moved;
    if (moved === 0) break;
  }

  const cancelled = await db.transaction(async (tx) => {
    await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
    const { pending } = await vaultRows(tx, owner);
    if (!pending) return false;
    const [left] = await tx.select({ n: count() }).from(dataKeys).where(ownedAtVersion(owner, pending.version));
    if (left.n > 0) return false;
    await tx.delete(vaultKeys).where(eq(vaultKeys.id, pending.id));
    await tx.delete(dataKeys).where(bridgeRows(owner));
    await tx
      .update(vaultRotations)
      .set({ state: "cancelled", completedAt: new Date() })
      .where(rotationRow(owner, pending.version));
    return true;
  });
  return { restored, cancelled };
}

/** Counts only: safe to show in the UI or a completion report. */
export async function rotationStatus(owner: VaultOwner) {
  const [pending] = await db
    .select()
    .from(vaultKeys)
    .where(
      and(
        eq(vaultKeys.ownerType, owner.ownerType),
        eq(vaultKeys.ownerId, owner.ownerId),
        eq(vaultKeys.status, "pending"),
      ),
    );
  if (!pending) return null;
  const [record] = await db.select().from(vaultRotations).where(rotationRow(owner, pending.version));
  const [left] = await db
    .select({ n: count() })
    .from(dataKeys)
    .where(ownedAtVersion(owner, (record?.fromVersion ?? pending.version - 1)));
  return {
    fromVersion: record?.fromVersion ?? pending.version - 1,
    toVersion: pending.version,
    state: record?.state ?? "running",
    rotated: record?.rotatedCount ?? 0,
    remaining: left.n,
  };
}
