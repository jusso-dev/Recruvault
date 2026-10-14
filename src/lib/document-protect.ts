import "server-only";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys } from "@/db/schema";
import { createDataKey, getDataKey, shredDataKey } from "@/lib/crypto";
import { wrapLegacyDek } from "@/lib/crypto-legacy";
import { enqueueDeletion } from "@/lib/deletion-queue";
import { scanBytes } from "@/lib/scan";
import { isMissingObjectError, opaqueStorageKey, getObjectBytes, putObjectBytes } from "@/lib/storage";
import { activeVault, documentCiphertext } from "@/lib/vault-store";
import { decryptDocumentBytes, documentAad } from "@/lib/vault-crypto";
import { readUnlockedCustomerKey } from "@/lib/vault-session";

type InsertExecutor = Pick<typeof db, "insert">;

/**
 * Document envelopes. Bytes are scanned in memory, encrypted under a fresh
 * per-document DEK, and only ciphertext reaches the object store.
 *
 * v1 bound the literal purpose "bytes"; v2 binds the document kind (jd, nda,
 * evidence, resume, ...) and the version itself. v1 objects stay readable.
 */
export const DOCUMENT_ENVELOPE_VERSION = 2;

// Organisation documents a secure-link responder must be able to open get an
// extra LOCAL_KEK wrap. Candidate evidence and wallet files never do.
const RENDER_DELEGATED_PURPOSES = new Set(["jd", "nda"]);

export function envelopeAad(
  ownerType: string,
  ownerId: string,
  documentId: string,
  purpose: string,
  version: number,
) {
  return version === 1
    ? documentAad(ownerType, ownerId, documentId, "bytes")
    : documentAad(ownerType, ownerId, documentId, purpose, version);
}

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
  // Tests and the legacy migration supply a verdict for bytes already scanned.
  scan?: (bytes: Buffer) => Promise<"clean" | "infected" | "error">;
}): Promise<
  | {
      ok: true;
      documentId: string;
      storageKey: string;
      ciphertext: Buffer;
      dekId: string;
      envelopeVersion: number;
      scanStatus: "clean";
    }
  | { ok: false; error: string }
> {
  const verdict = await (opts.scan ?? scanBytes)(opts.bytes);
  if (verdict === "infected") return { ok: false, error: "The file was rejected by the virus scanner." };
  if (verdict !== "clean") {
    return { ok: false, error: "Virus scanning is unavailable. The file was not stored." };
  }
  const documentId = opts.documentId ?? randomUUID();
  const aad = envelopeAad(opts.ownerType, opts.ownerId, documentId, opts.purpose, DOCUMENT_ENVELOPE_VERSION);
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
  if (opts.scope === "org" && RENDER_DELEGATED_PURPOSES.has(opts.purpose)) {
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
    envelopeVersion: DOCUMENT_ENVELOPE_VERSION,
    scanStatus: "clean",
  };
}

export async function putProtectedObject(storageKey: string, ciphertext: Buffer) {
  await putObjectBytes(storageKey, ciphertext, "application/octet-stream");
}

/**
 * Compensation for uploads whose database write did not commit: shred their
 * keys and queue the objects for durable deletion in one transaction.
 */
export async function discardProtectedUploads(
  uploads: { storageKey: string; dekId: string }[],
  ownerScope: string | null,
) {
  if (uploads.length === 0) return;
  await db.transaction(async (tx) => {
    for (const u of uploads) {
      await shredDataKey(u.dekId, tx);
      await enqueueDeletion(tx, u.storageKey, ownerScope);
    }
  });
}

export type DocumentAccessReason = "locked" | "shredded" | "integrity" | "missing";

/** Why a document could not be read. Callers map each reason to its own response. */
export class DocumentAccessError extends Error {
  constructor(readonly reason: DocumentAccessReason) {
    super(`Document unavailable: ${reason}.`);
    this.name = "DocumentAccessError";
  }
}

function keyFailure(error: unknown): DocumentAccessError {
  if (error instanceof DocumentAccessError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("shredded")) return new DocumentAccessError("shredded");
  if (message === "Vault is locked.") return new DocumentAccessError("locked");
  return new DocumentAccessError("integrity");
}

/**
 * Decrypt a stored document. Call only after authorisation. Fails closed: a
 * locked vault, shredded key, missing object, or any authentication failure
 * throws DocumentAccessError instead of returning partial or empty bytes.
 */
export async function readProtectedDocument(
  doc: {
    storageKey: string;
    envelopeVersion: number;
    dekId: string | null;
    contentType: string;
    originalContentType: string | null;
    ownerType: "organisation" | "candidate";
    ownerId: string;
    id: string;
    kind: string;
  },
  opts: { renderDelegation?: boolean; crk?: Buffer } = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  let stored: Buffer;
  try {
    stored = await getObjectBytes(doc.storageKey);
  } catch (error) {
    if (isMissingObjectError(error)) throw new DocumentAccessError("missing");
    throw error;
  }
  // Legacy plaintext object, readable until the migration moves it.
  if (!doc.envelopeVersion || !doc.dekId) return { bytes: stored, contentType: doc.contentType };

  let dek: Buffer;
  try {
    if (opts.renderDelegation) {
      dek = await getDataKey(doc.dekId, { allowRender: true });
    } else {
      const crk = opts.crk ?? (await readUnlockedCustomerKey(doc.ownerType, doc.ownerId));
      if (!crk) throw new DocumentAccessError("locked");
      dek = await getDataKey(doc.dekId, { crk });
    }
  } catch (error) {
    throw keyFailure(error);
  }
  try {
    const bytes = decryptDocumentBytes(
      dek,
      stored,
      envelopeAad(doc.ownerType, doc.ownerId, doc.id, doc.kind, doc.envelopeVersion),
    );
    return { bytes, contentType: doc.originalContentType || doc.contentType };
  } catch {
    throw new DocumentAccessError("integrity");
  }
}
