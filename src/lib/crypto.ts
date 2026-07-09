import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys } from "@/db/schema";

/**
 * Envelope encryption.
 *
 * Every encrypted record gets its own 256-bit data encryption key (DEK). The
 * DEK is wrapped by the customer master key in AWS KMS (ap-southeast-2) and
 * stored in the data_keys registry. Deleting a record is a crypto-shred:
 * destroy the wrapped DEK and the ciphertext is unrecoverable.
 *
 * In local development (no KMS_KEY_ID) DEKs are wrapped with a local KEK from
 * the LOCAL_KEK env var. That mode must never be used in production.
 */

const KMS_KEY_ID = process.env.KMS_KEY_ID;

let kms: KMSClient | undefined;
function kmsClient() {
  kms ??= new KMSClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });
  return kms;
}

function localKek(): Buffer {
  // Fail closed: the local KEK path must never run in production unless the
  // operator has explicitly opted in (mirrors the env validation in env.ts).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LOCAL_KEK_IN_PRODUCTION !== "true"
  ) {
    throw new Error(
      "Refusing to use LOCAL_KEK in production. Set KMS_KEY_ID, or opt in with ALLOW_LOCAL_KEK_IN_PRODUCTION=true.",
    );
  }
  const hex = process.env.LOCAL_KEK;
  if (!hex) {
    throw new Error(
      "No KMS_KEY_ID and no LOCAL_KEK configured — cannot wrap data keys.",
    );
  }
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

// Bind each wrapped DEK to its registry id so a wrapped blob from one record
// cannot be substituted into another — KMS decrypt fails if the context differs.
function dekContext(dekId: string): Record<string, string> {
  return { dekId };
}

async function wrapDek(
  dek: Buffer,
  dekId: string,
): Promise<{ wrapped: string; source: "kms" | "local" }> {
  if (KMS_KEY_ID) {
    const out = await kmsClient().send(
      new EncryptCommand({
        KeyId: KMS_KEY_ID,
        Plaintext: dek,
        EncryptionContext: dekContext(dekId),
      }),
    );
    return { wrapped: Buffer.from(out.CiphertextBlob!).toString("base64"), source: "kms" };
  }
  return { wrapped: aesEncrypt(localKek(), dek), source: "local" };
}

async function unwrapDek(wrapped: string, source: string, dekId: string): Promise<Buffer> {
  if (source === "kms") {
    const out = await kmsClient().send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(wrapped, "base64"),
        KeyId: KMS_KEY_ID,
        EncryptionContext: dekContext(dekId),
      }),
    );
    return Buffer.from(out.Plaintext!);
  }
  return aesDecrypt(localKek(), wrapped);
}

/** Create and register a new DEK. Returns its registry id and raw key. */
export async function createDataKey(): Promise<{ dekId: string; dek: Buffer }> {
  const dek = randomBytes(32);
  // Generate the id up front so it can bind the wrapped key via EncryptionContext.
  const dekId = randomUUID();
  const { wrapped, source } = await wrapDek(dek, dekId);
  await db.insert(dataKeys).values({ id: dekId, wrappedKey: wrapped, keySource: source });
  return { dekId, dek };
}

/** Fetch and unwrap a DEK. Throws if the key has been shredded. */
export async function getDataKey(dekId: string): Promise<Buffer> {
  const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, dekId));
  if (!row) throw new Error("Data key not found.");
  if (row.shreddedAt || !row.wrappedKey) throw new Error("Data key has been shredded.");
  return unwrapDek(row.wrappedKey, row.keySource, dekId);
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
