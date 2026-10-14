import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/** Field ciphertext and legacy LOCAL_KEK wraps. No authenticated owner context. */

export function localKek(): Buffer {
  const hex = process.env.LOCAL_KEK;
  if (!hex) throw new Error("LOCAL_KEK is required to wrap data keys.");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("LOCAL_KEK must be 32 bytes of hex.");
  return key;
}

export function aesEncrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function aesDecrypt(key: Buffer, payload: string): Buffer {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed ciphertext.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
}

export function wrapLegacyDek(dek: Buffer): string {
  return aesEncrypt(localKek(), dek);
}

export function unwrapLegacyDek(wrapped: string): Buffer {
  return aesDecrypt(localKek(), wrapped);
}
