import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys, vaultKeys } from "@/db/schema";
import { unwrapLegacyDek } from "@/lib/crypto-legacy";
import {
  customerKeyVerifier,
  encryptDocumentBytes,
  fieldAad,
  generateRecipientKeyPair,
  openCrkWrap,
  openLinkWrap,
  openSeal,
  privateKeyAad,
  sealToPublicKey,
  VaultCryptoError,
  verifierMatches,
  wrapWithCrk,
  wrapWithLinkSecret,
  type KdfParams,
  type RecipientKeyPair,
} from "@/lib/vault-crypto";

type InsertExecutor = Pick<typeof db, "insert">;
type SqlExecutor = Pick<typeof db, "execute">;
type VaultKeyRow = typeof vaultKeys.$inferSelect;
type DataKeyRow = typeof dataKeys.$inferSelect;

/** Purpose of the data-key row that carries the pending key during a rotation. */
export const ROTATION_BRIDGE_PURPOSE = "vault-rotation-bridge";

export type WrapSpec =
  | { mode: "legacy" }
  | {
      mode: "crk";
      crk: Buffer;
      ownerType: string;
      ownerId: string;
      purpose: string;
      keyVersion: number;
    }
  | {
      mode: "sealed";
      recipientPublicKey: string;
      ownerType: string;
      ownerId: string;
      purpose: string;
      keyVersion: number;
    }
  | { mode: "link"; linkSecret: string; purpose: string; linkId?: string };

export interface KeyMaterial {
  crk?: Buffer;
  linkSecret?: string;
  /** Authorised secure-link rendering of a document that opted into delegation. */
  allowRender?: boolean;
}

/** Serialise enrolment, rotation, and cancellation for one vault owner. */
export async function lockVaultOwner(tx: SqlExecutor, ownerType: string, ownerId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`vault:${ownerType}:${ownerId}`}, 0))`);
}

/** True for a unique-index violation, e.g. a second concurrent enrolment. */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: string }).code === "23505") return true;
  }
  return false;
}

export async function insertVaultKey(
  executor: InsertExecutor,
  input: {
    ownerType: "organisation" | "candidate";
    ownerId: string;
    crk: Buffer;
    version?: number;
    status?: "active" | "pending";
    kdf?: string | null;
    kdfSalt?: string | null;
    kdfParams?: KdfParams | null;
    keyPair?: RecipientKeyPair;
  },
) {
  const version = input.version ?? 1;
  const pair = input.keyPair ?? generateRecipientKeyPair();
  const aad = privateKeyAad(input.ownerType, input.ownerId, version);
  const [row] = await executor
    .insert(vaultKeys)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      version,
      status: input.status ?? "active",
      verifier: customerKeyVerifier(input.crk, input.ownerType, input.ownerId),
      publicKey: pair.publicKey,
      privateKeyWrapped: wrapWithCrk(input.crk, Buffer.from(pair.privateKey, "utf8"), aad),
      kdf: input.kdf ?? null,
      kdfSalt: input.kdfSalt ?? null,
      kdfParams: input.kdfParams ?? null,
    })
    .returning();
  return row;
}

export async function activeVault(ownerType: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(vaultKeys)
    .where(
      and(eq(vaultKeys.ownerType, ownerType), eq(vaultKeys.ownerId, ownerId), eq(vaultKeys.status, "active")),
    );
  return row ?? null;
}

async function requestCustomerKey(ownerType: string, ownerId: string): Promise<Buffer | undefined> {
  const { readUnlockedCustomerKey } = await import("@/lib/vault-session");
  return readUnlockedCustomerKey(ownerType, ownerId);
}

/** The AAD a data key must carry, recomputed from its columns rather than read back. */
export function expectedDataKeyAad(row: Pick<DataKeyRow, "id" | "wrapMode" | "ownerType" | "ownerId" | "purpose" | "keyVersion">) {
  if (row.wrapMode === "link") {
    return fieldAad(row.ownerType ?? "link", row.ownerId ?? "link", row.id, row.purpose ?? "", row.keyVersion);
  }
  if (!row.ownerType || !row.ownerId || !row.purpose) throw new VaultCryptoError("Key metadata is incomplete.");
  return fieldAad(row.ownerType, row.ownerId, row.id, row.purpose, row.keyVersion);
}

export function bridgeAad(ownerType: string, ownerId: string, bridgeId: string, fromVersion: number) {
  return fieldAad(ownerType, ownerId, bridgeId, ROTATION_BRIDGE_PURPOSE, fromVersion);
}

/**
 * Open the rotation bridge: the pending key wrapped under the active key. It
 * exists only while a rotation is pending so holders of the active key can
 * read records already rewrapped, and is deleted when the rotation ends.
 */
async function openRotationBridge(
  ownerType: string,
  ownerId: string,
  fromVersion: number,
  crk: Buffer,
): Promise<Buffer | undefined> {
  const [bridge] = await db
    .select()
    .from(dataKeys)
    .where(
      and(
        eq(dataKeys.ownerType, ownerType),
        eq(dataKeys.ownerId, ownerId),
        eq(dataKeys.purpose, ROTATION_BRIDGE_PURPOSE),
        eq(dataKeys.keyVersion, fromVersion),
        isNull(dataKeys.shreddedAt),
      ),
    );
  if (!bridge?.wrappedKey) return undefined;
  try {
    return openCrkWrap(crk, bridge.wrappedKey, bridgeAad(ownerType, ownerId, bridge.id, fromVersion));
  } catch {
    return undefined;
  }
}

/** Resolve the customer key that opens `version`, following a pending-rotation bridge. */
export async function keyForVersion(
  ownerType: string,
  ownerId: string,
  version: number,
  crk: Buffer,
): Promise<{ crk: Buffer; vault: VaultKeyRow }> {
  const rows = await db
    .select()
    .from(vaultKeys)
    .where(and(eq(vaultKeys.ownerType, ownerType), eq(vaultKeys.ownerId, ownerId)));
  const target = rows.find((row) => row.version === version);
  if (!target || target.status === "retired") throw new VaultCryptoError("Vault is locked.");
  if (verifierMatches(crk, ownerType, ownerId, target.verifier)) return { crk, vault: target };
  const holder = rows.find(
    (row) => row.version < version && row.status === "active" && verifierMatches(crk, ownerType, ownerId, row.verifier),
  );
  if (!holder || target.status !== "pending") throw new VaultCryptoError("Vault is locked.");
  const bridged = await openRotationBridge(ownerType, ownerId, holder.version, crk);
  if (!bridged || !verifierMatches(bridged, ownerType, ownerId, target.verifier)) {
    throw new VaultCryptoError("Vault is locked.");
  }
  return { crk: bridged, vault: target };
}

function openPrivateKey(vault: VaultKeyRow, crk: Buffer): string {
  if (!vault.privateKeyWrapped) throw new VaultCryptoError("Vault is locked.");
  return openCrkWrap(
    crk,
    vault.privateKeyWrapped,
    privateKeyAad(vault.ownerType, vault.ownerId, vault.version),
  ).toString("utf8");
}

/** Open a crk or sealed wrap with a key already resolved for the row's version. */
export function openOwnerWrap(row: DataKeyRow, vault: VaultKeyRow, crk: Buffer): Buffer {
  if (!row.wrappedKey) throw new Error("Data key has been shredded.");
  const aad = expectedDataKeyAad(row);
  if (row.wrapMode === "crk") return openCrkWrap(crk, row.wrappedKey, aad);
  if (row.wrapMode === "sealed") return openSeal(openPrivateKey(vault, crk), vault.publicKey, row.wrappedKey, aad);
  throw new VaultCryptoError("Unknown key wrap.");
}

export async function unwrapDataKeyRow(row: DataKeyRow, material?: KeyMaterial): Promise<Buffer> {
  if (row.shreddedAt || !row.wrappedKey) throw new Error("Data key has been shredded.");
  if (material?.allowRender && row.renderWrapped) return unwrapLegacyDek(row.renderWrapped);
  if (row.wrapMode === "legacy" || row.keySource === "local") {
    return unwrapLegacyDek(row.wrappedKey);
  }
  if (row.wrapMode === "link") {
    if (!material?.linkSecret) throw new VaultCryptoError("Vault is locked.");
    return openLinkWrap(material.linkSecret, row.wrappedKey, expectedDataKeyAad(row));
  }
  if (!row.ownerType || !row.ownerId) throw new VaultCryptoError("Vault is locked.");
  const held = material?.crk ?? (await requestCustomerKey(row.ownerType, row.ownerId));
  if (!held) throw new VaultCryptoError("Vault is locked.");
  const resolved = await keyForVersion(row.ownerType, row.ownerId, row.keyVersion, held);
  return openOwnerWrap(row, resolved.vault, resolved.crk);
}

/**
 * The key version as a locking subquery: the insert takes a share lock on the
 * owner's active vault row, so it either commits before a rotation switch
 * re-counts old-version rows or sees the switch and fails with a null version.
 */
function activeVersionGuard(ownerType: string, ownerId: string, version: number) {
  return sql`(select ${vaultKeys.version} from ${vaultKeys} where ${vaultKeys.ownerType} = ${ownerType} and ${vaultKeys.ownerId} = ${ownerId} and ${vaultKeys.version} = ${version} and ${vaultKeys.status} = 'active' for share)`;
}

function isNotNullViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: string }).code === "23502") return true;
  }
  return false;
}

export async function insertWrappedDataKey(
  executor: InsertExecutor,
  dekId: string,
  dek: Buffer,
  wrap: Exclude<WrapSpec, { mode: "legacy" }>,
) {
  if (wrap.mode === "crk" || wrap.mode === "sealed") {
    const aad = fieldAad(wrap.ownerType, wrap.ownerId, dekId, wrap.purpose, wrap.keyVersion);
    try {
      await executor.insert(dataKeys).values({
        id: dekId,
        wrappedKey:
          wrap.mode === "crk"
            ? wrapWithCrk(wrap.crk, dek, aad)
            : sealToPublicKey(wrap.recipientPublicKey, dek, aad),
        keySource: "customer",
        wrapMode: wrap.mode,
        ownerType: wrap.ownerType,
        ownerId: wrap.ownerId,
        purpose: wrap.purpose,
        keyVersion: activeVersionGuard(wrap.ownerType, wrap.ownerId, wrap.keyVersion),
        aad,
      });
    } catch (error) {
      if (isNotNullViolation(error)) {
        throw new VaultCryptoError("The encryption key changed while saving. Try again.");
      }
      throw error;
    }
    return;
  }
  const aad = fieldAad("link", wrap.linkId ?? "link", dekId, wrap.purpose, 0);
  await executor.insert(dataKeys).values({
    id: dekId,
    wrappedKey: wrapWithLinkSecret(wrap.linkSecret, dek, aad),
    keySource: "customer",
    wrapMode: "link",
    ownerType: wrap.linkId ? "link" : null,
    ownerId: wrap.linkId ?? null,
    purpose: wrap.purpose,
    keyVersion: 0,
    aad,
  });
}

export function documentCiphertext(dek: Buffer, plaintext: Buffer, aad: string): Buffer {
  return encryptDocumentBytes(dek, plaintext, aad);
}
