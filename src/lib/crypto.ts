import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys } from "@/db/schema";

/**
 * Envelope encryption.
 *
 * Every encrypted record gets its own 256-bit data encryption key (DEK). The
 * DEK is wrapped by a self-managed 256-bit master key (KEK) held in the
 * LOCAL_KEK env var and stored, wrapped, in the data_keys registry. Deleting a
 * record is a crypto-shred: destroy the wrapped DEK and the ciphertext is
 * unrecoverable. No external KMS is required; keep LOCAL_KEK secret and backed
 * up (losing it makes all ciphertext unrecoverable).
 */

function localKek(): Buffer {
  const hex = process.env.LOCAL_KEK;
  if (!hex) throw new Error("LOCAL_KEK is required to wrap data keys.");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("LOCAL_KEK must be 32 bytes of hex.");
  return key;
}

function aesEncrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

function aesDecrypt(key: Buffer, payload: string): Buffer {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed ciphertext.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
}

function wrapDek(dek: Buffer): { wrapped: string; source: "local" } {
  return { wrapped: aesEncrypt(localKek(), dek), source: "local" };
}

// `source` is kept for the data_keys registry (only "local" is produced now).
function unwrapDek(wrapped: string): Buffer {
  return aesDecrypt(localKek(), wrapped);
}

/**
 * Create and register a new DEK. Returns its registry id and raw key. Pass a
 * transaction executor to enrol the DEK insert into a surrounding transaction.
 */
export async function createDataKey(
  executor: Pick<typeof db, "insert"> = db,
): Promise<{ dekId: string; dek: Buffer }> {
  const dek = randomBytes(32);
  const dekId = randomUUID();
  const { wrapped, source } = wrapDek(dek);
  await executor.insert(dataKeys).values({ id: dekId, wrappedKey: wrapped, keySource: source });
  return { dekId, dek };
}

/** Fetch and unwrap a DEK. Throws if the key has been shredded. */
export async function getDataKey(dekId: string): Promise<Buffer> {
  const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, dekId));
  if (!row) throw new Error("Data key not found.");
  if (row.shreddedAt || !row.wrappedKey) throw new Error("Data key has been shredded.");
  return unwrapDek(row.wrappedKey);
}

/** A db handle or an open transaction — lets callers shred atomically. */
type Executor = Pick<typeof db, "update">;

/**
 * Crypto-shred: destroy the wrapped key material so all ciphertext encrypted
 * under this DEK is permanently unrecoverable. Pass a transaction to shred and
 * drop the ciphertext rows as one atomic unit.
 */
export async function shredDataKey(dekId: string, executor: Executor = db): Promise<void> {
  await executor
    .update(dataKeys)
    .set({ wrappedKey: null, shreddedAt: new Date() })
    .where(eq(dataKeys.id, dekId));
}

/** Encrypt a field value under a fresh DEK. */
export async function encryptField(
  plaintext: string,
): Promise<{ valueEncrypted: string; dekId: string }> {
  const { dekId, dek } = await createDataKey();
  return { valueEncrypted: aesEncrypt(dek, Buffer.from(plaintext, "utf8")), dekId };
}

/** Encrypt a field value under an existing DEK (e.g. one DEK per submission). */
export async function encryptFieldWithKey(plaintext: string, dek: Buffer): Promise<string> {
  return aesEncrypt(dek, Buffer.from(plaintext, "utf8"));
}

/** Decrypt a field value. Throws if its DEK has been shredded. */
export async function decryptField(valueEncrypted: string, dekId: string): Promise<string> {
  const dek = await getDataKey(dekId);
  return aesDecrypt(dek, valueEncrypted).toString("utf8");
}

/** Decrypt a field value with an already-unwrapped DEK (no DB/KMS call). */
export function decryptFieldWithKey(valueEncrypted: string, dek: Buffer): string {
  return aesDecrypt(dek, valueEncrypted).toString("utf8");
}

/**
 * Per-request memo of unwrapped DEKs. Submissions share one DEK per record, so
 * this collapses N KMS Decrypt calls to one. Never module-global — plaintext
 * DEKs must not outlive the request. Stores the promise to dedupe concurrent
 * unwraps of the same key.
 */
export function createDekCache(): { getKey(dekId: string): Promise<Buffer> } {
  const cache = new Map<string, Promise<Buffer>>();
  return {
    getKey(dekId: string): Promise<Buffer> {
      let p = cache.get(dekId);
      if (!p) {
        p = getDataKey(dekId);
        cache.set(dekId, p);
      }
      return p;
    },
  };
}

// ---------------------------------------------------------------------------
// Token helpers (secure links and OTP)
// ---------------------------------------------------------------------------

/** Opaque, high-entropy, URL-safe token. Only its SHA-256 is stored. */
export function generateOpaqueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256(token) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Six-digit one-time code for step-up verification. */
export function generateOtp(): { code: string; codeHash: string } {
  const code = (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
  return { code, codeHash: sha256(code) };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
