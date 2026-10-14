import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Encrypted backup archive. R2 only ever receives this ciphertext.
 * The 256-bit key is not stored in the archive.
 */

export const BACKUP_MAGIC = Buffer.from("RVBAK1");
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}

export interface BackupFrame {
  type: number;
  payload: Buffer;
}

export function generateBackupKey(): Buffer {
  return randomBytes(32);
}

export function encodeBackupKey(key: Buffer): string {
  return key.toString("base64url");
}

export function decodeBackupKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64url");
  if (key.length !== 32) throw new BackupFormatError("Backup key must be 256 bits.");
  return key;
}

export function sealBackup(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== 32) throw new BackupFormatError("Backup key must be 256 bits.");
  if (plaintext.length > MAX_BACKUP_BYTES) {
    throw new BackupFormatError("Backup is larger than 200 MB and was not uploaded.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, Buffer.from([1]), iv, tag, ciphertext]);
}

export function openBackup(key: Buffer, archive: Buffer): Buffer {
  if (key.length !== 32) throw new BackupFormatError("Backup key must be 256 bits.");
  if (archive.length < BACKUP_MAGIC.length + 1 + 12 + 16) {
    throw new BackupFormatError("Backup archive is truncated.");
  }
  if (!archive.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new BackupFormatError("Backup archive header is not recognised.");
  }
  if (archive[BACKUP_MAGIC.length] !== 1) throw new BackupFormatError("Unsupported backup version.");
  const ivStart = BACKUP_MAGIC.length + 1;
  const iv = archive.subarray(ivStart, ivStart + 12);
  const tag = archive.subarray(ivStart + 12, ivStart + 28);
  const ciphertext = archive.subarray(ivStart + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encodeFrames(frames: BackupFrame[]): Buffer {
  const parts: Buffer[] = [];
  for (const frame of frames) {
    if (frame.type < 1 || frame.type > 255) throw new BackupFormatError("Invalid backup frame.");
    const header = Buffer.alloc(5);
    header.writeUInt8(frame.type, 0);
    header.writeUInt32BE(frame.payload.length, 1);
    parts.push(header, frame.payload);
  }
  return Buffer.concat(parts);
}

export function decodeFrames(plaintext: Buffer): BackupFrame[] {
  const frames: BackupFrame[] = [];
  let offset = 0;
  while (offset < plaintext.length) {
    if (plaintext.length - offset < 5) throw new BackupFormatError("Truncated backup frame.");
    const type = plaintext.readUInt8(offset);
    const length = plaintext.readUInt32BE(offset + 1);
    offset += 5;
    if (length < 0 || offset + length > plaintext.length) {
      throw new BackupFormatError("Truncated backup frame.");
    }
    frames.push({ type, payload: plaintext.subarray(offset, offset + length) });
    offset += length;
  }
  return frames;
}

export function checksumArchive(archive: Buffer): string {
  return createHash("sha256").update(archive).digest("hex");
}

export function serializeValue(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bytea: value.toString("base64") };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeValue(entry);
    }
    return out;
  }
  return value;
}

export function reviveValue(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reviveValue);
  const record = value as Record<string, unknown>;
  if (typeof record.$date === "string" && Object.keys(record).length === 1) return new Date(record.$date);
  if (typeof record.$bytea === "string" && Object.keys(record).length === 1) {
    return Buffer.from(record.$bytea, "base64");
  }
  if (typeof record.$bigint === "string" && Object.keys(record).length === 1) return record.$bigint;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = reviveValue(entry);
  return out;
}

export interface BackupFormInput {
  enabled: boolean;
  hourUtc: number;
  retainCount: number;
  r2AccountId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2Secret?: string;
  hasExistingSecret: boolean;
}

export function validateBackupForm(
  input: BackupFormInput,
): { ok: true; value: BackupFormInput } | { ok: false; error: string } {
  if (!Number.isInteger(input.hourUtc) || input.hourUtc < 0 || input.hourUtc > 23) {
    return { ok: false, error: "Choose an hour from 0 to 23 UTC." };
  }
  if (!Number.isInteger(input.retainCount) || input.retainCount < 1 || input.retainCount > 90) {
    return { ok: false, error: "Keep between 1 and 90 backups." };
  }
  if (!/^[a-zA-Z0-9]{16,64}$/.test(input.r2AccountId)) {
    return { ok: false, error: "Enter the Cloudflare account id." };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.r2Bucket)) {
    return { ok: false, error: "Enter an R2 bucket name." };
  }
  if (!/^[A-Za-z0-9]{8,128}$/.test(input.r2AccessKeyId)) {
    return { ok: false, error: "Enter the R2 access key id." };
  }
  if (!input.r2Secret && !input.hasExistingSecret) {
    return { ok: false, error: "Enter the R2 secret access key." };
  }
  if (input.r2Secret && input.r2Secret.length < 16) {
    return { ok: false, error: "The R2 secret access key is too short." };
  }
  return { ok: true, value: input };
}

/** Run once the configured UTC hour has been reached and today has not succeeded. */
export function nightlyBackupDue(input: {
  enabled: boolean;
  hourUtc: number;
  now: Date;
  alreadySucceededToday: boolean;
}): boolean {
  if (!input.enabled || input.alreadySucceededToday) return false;
  return input.now.getUTCHours() >= input.hourUtc;
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
