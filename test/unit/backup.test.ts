import { describe, expect, it } from "vitest";
import {
  checksumArchive,
  encodeFrames,
  nightlyBackupDue,
  openBackup,
  reviveValue,
  sealBackup,
  serializeValue,
  validateBackupForm,
} from "@/lib/backup-crypto";
import { buildBackupPlaintext, readBackupPlaintext } from "@/lib/backup";

describe("encrypted backup archives", () => {
  it("round-trips a database row and an object without leaving plaintext in the archive", () => {
    const key = Buffer.alloc(32, 7);
    const created = new Date("2026-10-14T16:00:00.000Z");
    const plaintext = buildBackupPlaintext({
      createdAt: created.toISOString(),
      tables: [
        {
          table: "organisations",
          rows: [serializeValue({ id: "org", createdAt: created, secret: Buffer.from("nope") }) as Record<string, unknown>],
        },
      ],
      objects: [{ key: "org/doc", body: Buffer.from("%PDF-career") }],
    });
    const archive = sealBackup(key, plaintext);
    expect(archive.subarray(0, 6).toString()).toBe("RVBAK1");
    expect(archive.includes("%PDF-career")).toBe(false);
    expect(archive.includes(Buffer.from("nope"))).toBe(false);

    const opened = readBackupPlaintext(openBackup(key, archive));
    expect(opened.tables[0]?.table).toBe("organisations");
    const row = reviveValue(opened.tables[0]?.rows[0]) as { createdAt: Date; secret: Buffer };
    expect(row.createdAt.toISOString()).toBe(created.toISOString());
    expect(row.secret.equals(Buffer.from("nope"))).toBe(true);
    expect(opened.objects[0]?.body.equals(Buffer.from("%PDF-career"))).toBe(true);
    expect(checksumArchive(archive)).toHaveLength(64);
  });

  it("rejects a tampered archive and the wrong key", () => {
    const key = Buffer.alloc(32, 3);
    const archive = sealBackup(key, encodeFrames([{ type: 1, payload: Buffer.from("{}") }]));
    archive[archive.length - 1] ^= 0xff;
    expect(() => openBackup(key, archive)).toThrow();
    const intact = sealBackup(key, Buffer.from("frames"));
    expect(() => openBackup(Buffer.alloc(32, 4), intact)).toThrow();
  });

  it("decides when the nightly job should run", () => {
    const now = new Date("2026-10-14T16:05:00.000Z");
    expect(nightlyBackupDue({ enabled: true, hourUtc: 16, now, alreadySucceededToday: false })).toBe(true);
    expect(nightlyBackupDue({ enabled: true, hourUtc: 17, now, alreadySucceededToday: false })).toBe(false);
    expect(nightlyBackupDue({ enabled: true, hourUtc: 16, now, alreadySucceededToday: true })).toBe(false);
    expect(nightlyBackupDue({ enabled: false, hourUtc: 16, now, alreadySucceededToday: false })).toBe(false);
  });

  it("requires an R2 secret until one is already saved", () => {
    const base = {
      enabled: true,
      hourUtc: 16,
      retainCount: 14,
      r2AccountId: "a".repeat(32),
      r2Bucket: "recruvault-backups",
      r2AccessKeyId: "accesskeyidvalue",
      hasExistingSecret: false,
    };
    expect(validateBackupForm(base).ok).toBe(false);
    expect(validateBackupForm({ ...base, r2Secret: "long-enough-secret" }).ok).toBe(true);
    expect(validateBackupForm({ ...base, hasExistingSecret: true }).ok).toBe(true);
  });
});
