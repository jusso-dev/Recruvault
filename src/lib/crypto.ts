import "server-only";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys } from "@/db/schema";
import { aesDecrypt, aesEncrypt, unwrapLegacyDek, wrapLegacyDek } from "@/lib/crypto-legacy";
import { insertWrappedDataKey, unwrapDataKeyRow, type KeyMaterial, type WrapSpec } from "@/lib/vault-store";

/**
 * Envelope encryption.
 *
 * Legacy records wrap each DEK with the deployment LOCAL_KEK. New records wrap
 * the DEK with the owning customer key, or seal it to the owner's public key
 * when the writer does not hold that key (secure-link submission). LOCAL_KEK
 * is not a fallback for customer envelopes.
 */

type InsertExecutor = Pick<typeof db, "insert">;

export async function createDataKey(
  executor: InsertExecutor = db,
  wrap: WrapSpec = { mode: "legacy" },
): Promise<{ dekId: string; dek: Buffer }> {
  const dek = randomBytes(32);
  const dekId = randomUUID();
  if (wrap.mode === "legacy") {
    await executor.insert(dataKeys).values({
      id: dekId,
      wrappedKey: wrapLegacyDek(dek),
      keySource: "local",
      wrapMode: "legacy",
    });
    return { dekId, dek };
  }
  await insertWrappedDataKey(executor, dekId, dek, wrap);
  return { dekId, dek };
}

export async function getDataKey(dekId: string, material?: KeyMaterial): Promise<Buffer> {
  const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, dekId));
  if (!row) throw new Error("Data key not found.");
  if (row.shreddedAt || !row.wrappedKey) throw new Error("Data key has been shredded.");
  if (row.wrapMode === "legacy" || row.keySource === "local") return unwrapLegacyDek(row.wrappedKey);
  return unwrapDataKeyRow(row, material);
}

type Executor = Pick<typeof db, "update">;

export async function shredDataKey(dekId: string, executor: Executor = db): Promise<void> {
  await executor
    .update(dataKeys)
    .set({ wrappedKey: null, shreddedAt: new Date() })
    .where(eq(dataKeys.id, dekId));
}

export async function encryptField(
  plaintext: string,
  wrap: WrapSpec = { mode: "legacy" },
): Promise<{ valueEncrypted: string; dekId: string }> {
  const { dekId, dek } = await createDataKey(db, wrap);
  return { valueEncrypted: aesEncrypt(dek, Buffer.from(plaintext, "utf8")), dekId };
}

export async function encryptFieldWithKey(plaintext: string, dek: Buffer): Promise<string> {
  return aesEncrypt(dek, Buffer.from(plaintext, "utf8"));
}

export async function decryptField(
  valueEncrypted: string,
  dekId: string,
  material?: KeyMaterial,
): Promise<string> {
  const dek = await getDataKey(dekId, material);
  return aesDecrypt(dek, valueEncrypted).toString("utf8");
}

export function decryptFieldWithKey(valueEncrypted: string, dek: Buffer): string {
  return aesDecrypt(dek, valueEncrypted).toString("utf8");
}

export function createDekCache(material?: KeyMaterial): { getKey(dekId: string): Promise<Buffer> } {
  const cache = new Map<string, Promise<Buffer>>();
  return {
    getKey(dekId: string): Promise<Buffer> {
      let pending = cache.get(dekId);
      if (!pending) {
        pending = getDataKey(dekId, material);
        cache.set(dekId, pending);
      }
      return pending;
    },
  };
}

export function generateOpaqueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256(token) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateOtp(): { code: string; codeHash: string } {
  const code = (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
  return { code, codeHash: sha256(code) };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function tokenMatches(presented: string, expected: string): boolean {
  const actual = createHash("sha256").update(presented).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, wanted);
}
