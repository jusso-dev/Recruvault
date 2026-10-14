import "server-only";
import { and, eq } from "drizzle-orm";
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
  type RecipientKeyPair,
} from "@/lib/vault-crypto";

type InsertExecutor = Pick<typeof db, "insert">;

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
  | { mode: "link"; linkSecret: string; purpose: string };

export interface KeyMaterial {
  crk?: Buffer;
  linkSecret?: string;
  /** Authorised secure-link rendering of a document that opted into delegation. */
  allowRender?: boolean;
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
    kdfParams?: { N: number; r: number; p: number; version: number } | null;
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

async function privateKeyFor(
  ownerType: string,
  ownerId: string,
  version: number,
  crk: Buffer,
): Promise<{ privateKey: string; publicKey: string }> {
  const [row] = await db
    .select()
    .from(vaultKeys)
    .where(
      and(
        eq(vaultKeys.ownerType, ownerType),
        eq(vaultKeys.ownerId, ownerId),
        eq(vaultKeys.version, version),
      ),
    );
  if (!row?.privateKeyWrapped) throw new VaultCryptoError("Vault is locked.");
  if (!verifierMatches(crk, ownerType, ownerId, row.verifier)) {
    throw new VaultCryptoError("Vault is locked.");
  }
  const privateKey = openCrkWrap(
    crk,
    row.privateKeyWrapped,
    privateKeyAad(ownerType, ownerId, version),
  ).toString("utf8");
  return { privateKey, publicKey: row.publicKey };
}

export async function unwrapDataKeyRow(
  row: typeof dataKeys.$inferSelect,
  material?: KeyMaterial,
): Promise<Buffer> {
  if (row.shreddedAt || !row.wrappedKey) throw new Error("Data key has been shredded.");
  if (material?.allowRender && row.renderWrapped) return unwrapLegacyDek(row.renderWrapped);
  if (row.wrapMode === "legacy" || row.keySource === "local") {
    return unwrapLegacyDek(row.wrappedKey);
  }
  if (row.wrapMode === "link") {
    if (!material?.linkSecret) throw new VaultCryptoError("Vault is locked.");
    return openLinkWrap(material.linkSecret, row.wrappedKey, row.aad ?? "");
  }
  if (!row.ownerType || !row.ownerId) throw new VaultCryptoError("Vault is locked.");
  const crk = material?.crk ?? (await requestCustomerKey(row.ownerType, row.ownerId));
  if (!crk) throw new VaultCryptoError("Vault is locked.");
  if (row.wrapMode === "crk") return openCrkWrap(crk, row.wrappedKey, row.aad ?? "");
  if (row.wrapMode === "sealed") {
    const owner = await privateKeyFor(row.ownerType, row.ownerId, row.keyVersion, crk);
    return openSeal(owner.privateKey, owner.publicKey, row.wrappedKey, row.aad ?? "");
  }
  throw new VaultCryptoError("Unknown key wrap.");
}

export async function insertWrappedDataKey(
  executor: InsertExecutor,
  dekId: string,
  dek: Buffer,
  wrap: Exclude<WrapSpec, { mode: "legacy" }>,
) {
  if (wrap.mode === "crk") {
    const aad = fieldAad(wrap.ownerType, wrap.ownerId, dekId, wrap.purpose, wrap.keyVersion);
    await executor.insert(dataKeys).values({
      id: dekId,
      wrappedKey: wrapWithCrk(wrap.crk, dek, aad),
      keySource: "customer",
      wrapMode: "crk",
      ownerType: wrap.ownerType,
      ownerId: wrap.ownerId,
      purpose: wrap.purpose,
      keyVersion: wrap.keyVersion,
      aad,
    });
    return;
  }
  if (wrap.mode === "sealed") {
    const aad = fieldAad(wrap.ownerType, wrap.ownerId, dekId, wrap.purpose, wrap.keyVersion);
    await executor.insert(dataKeys).values({
      id: dekId,
      wrappedKey: sealToPublicKey(wrap.recipientPublicKey, dek, aad),
      keySource: "customer",
      wrapMode: "sealed",
      ownerType: wrap.ownerType,
      ownerId: wrap.ownerId,
      purpose: wrap.purpose,
      keyVersion: wrap.keyVersion,
      aad,
    });
    return;
  }
  const aad = fieldAad("link", "link", dekId, wrap.purpose, 0);
  await executor.insert(dataKeys).values({
    id: dekId,
    wrappedKey: wrapWithLinkSecret(wrap.linkSecret, dek, aad),
    keySource: "customer",
    wrapMode: "link",
    purpose: wrap.purpose,
    keyVersion: 0,
    aad,
  });
}

export function documentCiphertext(dek: Buffer, plaintext: Buffer, aad: string): Buffer {
  return encryptDocumentBytes(dek, plaintext, aad);
}
