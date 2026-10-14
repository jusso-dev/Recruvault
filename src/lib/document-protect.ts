import "server-only";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys } from "@/db/schema";
import { createDataKey, getDataKey } from "@/lib/crypto";
import { wrapLegacyDek } from "@/lib/crypto-legacy";
import { scanBytes } from "@/lib/scan";
import { opaqueStorageKey, getObjectBytes, putObjectBytes } from "@/lib/storage";
import { activeVault, documentCiphertext } from "@/lib/vault-store";
import { decryptDocumentBytes, documentAad } from "@/lib/vault-crypto";
import { readUnlockedCustomerKey } from "@/lib/vault-session";

type InsertExecutor = Pick<typeof db, "insert">;

export async function requireActiveVault(ownerType: "organisation" | "candidate", ownerId: string) {
  const vault = await activeVault(ownerType, ownerId);
  if (!vault || !vault.privateKeyWrapped) {
    throw new Error("Encryption enrollment is required before this action.");
  }
  return vault;
}

export async function protectDocument(opts: {
  executor: InsertExecutor;
  bytes: Buffer;
  ownerType: "organisation" | "candidate";
  ownerId: string;
  purpose: string;
  documentId?: string;
  keyVersion: number;
  crk?: Buffer;
  recipientPublicKey?: string;
  scope: "org" | "wallet";
}): Promise<
  | {
      ok: true;
      documentId: string;
      storageKey: string;
      ciphertext: Buffer;
      dekId: string;
      envelopeVersion: 1;
      scanStatus: "clean";
    }
  | { ok: false; error: string }
> {
  const verdict = await scanBytes(opts.bytes);
  if (verdict === "infected") return { ok: false, error: "The file was rejected by the virus scanner." };
  if (verdict !== "clean") {
    return { ok: false, error: "Virus scanning is unavailable. The file was not stored." };
  }
  const documentId = opts.documentId ?? randomUUID();
  const aad = documentAad(opts.ownerType, opts.ownerId, documentId, "bytes");
  let dekId: string;
  let dek: Buffer;
  if (opts.crk) {
    ({ dekId, dek } = await createDataKey(opts.executor, {
      mode: "crk",
      crk: opts.crk,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId,
      purpose: opts.purpose,
      keyVersion: opts.keyVersion,
    }));
  } else if (opts.recipientPublicKey) {
    ({ dekId, dek } = await createDataKey(opts.executor, {
      mode: "sealed",
      recipientPublicKey: opts.recipientPublicKey,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId,
      purpose: opts.purpose,
      keyVersion: opts.keyVersion,
    }));
  } else {
    return { ok: false, error: "Unlock the encryption key before uploading." };
  }
  if (opts.scope === "org") {
    await db
      .update(dataKeys)
      .set({ renderWrapped: wrapLegacyDek(dek) })
      .where(eq(dataKeys.id, dekId));
  }
  return {
    ok: true,
    documentId,
    storageKey: opaqueStorageKey(opts.scope, opts.ownerId),
    ciphertext: documentCiphertext(dek, opts.bytes, aad),
    dekId,
    envelopeVersion: 1,
    scanStatus: "clean",
  };
}

export async function putProtectedObject(storageKey: string, ciphertext: Buffer) {
  await putObjectBytes(storageKey, ciphertext, "application/octet-stream");
}

export async function readProtectedDocument(doc: {
  storageKey: string;
  envelopeVersion: number;
  dekId: string | null;
  contentType: string;
  originalContentType: string | null;
  ownerType: "organisation" | "candidate";
  ownerId: string;
  id: string;
}, opts?: { renderDelegation?: boolean }): Promise<{ bytes: Buffer; contentType: string }> {
  const stored = await getObjectBytes(doc.storageKey);
  const contentType = doc.originalContentType || doc.contentType;
  if (!doc.envelopeVersion || !doc.dekId) return { bytes: stored, contentType: doc.contentType };
  const crk = opts?.renderDelegation ? undefined : await readUnlockedCustomerKey(doc.ownerType, doc.ownerId);
  if (!crk && !opts?.renderDelegation) throw new Error("Vault is locked.");
  const dek = await getDataKey(doc.dekId, opts?.renderDelegation ? { allowRender: true } : { crk });
  const bytes = decryptDocumentBytes(
    dek,
    stored,
    documentAad(doc.ownerType, doc.ownerId, doc.id, "bytes"),
  );
  return { bytes, contentType };
}
