import { execFile } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import * as schema from "@/db/schema";
import { candidateAccounts, dataKeys, organisations, user, vaultKeys } from "@/db/schema";
import { setupMigratedDatabase, startTestDatabase, type TestDatabase } from "./harness";

/**
 * Backup → restore into a separate, freshly migrated database → decrypt with
 * the documented keys (backup key, LOCAL_KEK, customer key). Shredded keys
 * stay shredded. Values are synthetic.
 */

const run = promisify(execFile);
let db: typeof import("@/db").db;
let stop: () => Promise<void>;
const targets: TestDatabase[] = [];

beforeAll(async () => {
  process.env.LOCAL_KEK = "55".repeat(32);
  ({ db, stop } = await setupMigratedDatabase());
});

afterAll(async () => {
  for (const target of targets) await target.stop();
  await stop?.();
});

async function freshTarget() {
  const target = await startTestDatabase();
  targets.push(target);
  const client = new Client({ connectionString: target.url, options: "-c TimeZone=UTC" });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  return { target, client };
}

describe("encrypted backup restore", () => {
  it("restores into an isolated database that decrypts with the documented keys only", async () => {
    const crypto = await import("@/lib/crypto");
    const legacyCrypto = await import("@/lib/crypto-legacy");
    const store = await import("@/lib/vault-store");
    const vaultCrypto = await import("@/lib/vault-crypto");
    const backup = await import("@/lib/backup");
    const backupCrypto = await import("@/lib/backup-crypto");
    const restore = await import("@/lib/backup-restore");

    const [org] = await db.insert(organisations).values({ name: "Restore Org", slug: `restore-${randomUUID().slice(0, 6)}` }).returning();
    const userId = randomUUID();
    await db.insert(user).values({ id: userId, name: "Synthetic", email: "restore@example.invalid", emailVerified: true });
    const [candidate] = await db.insert(candidateAccounts).values({ userId }).returning();
    const orgKey = randomBytes(32);
    const seekerKey = randomBytes(32);
    const orgVault = await store.insertVaultKey(db, { ownerType: "organisation", ownerId: org.id, crk: orgKey });
    await store.insertVaultKey(db, { ownerType: "candidate", ownerId: candidate.id, crk: seekerKey });

    const owned = await crypto.encryptField("seeker-secret", {
      mode: "crk", crk: seekerKey, ownerType: "candidate", ownerId: candidate.id, purpose: "clearance_level", keyVersion: 1,
    });
    const sealed = await crypto.encryptField("org-sealed", {
      mode: "sealed", recipientPublicKey: orgVault.publicKey, ownerType: "organisation", ownerId: org.id, purpose: "submission", keyVersion: 1,
    });
    const legacy = await crypto.encryptField("legacy-value", { mode: "legacy" });
    const erased = await crypto.encryptField("erased-value", {
      mode: "crk", crk: seekerKey, ownerType: "candidate", ownerId: candidate.id, purpose: "phone", keyVersion: 1,
    });
    await crypto.shredDataKey(erased.dekId);
    const doc = await crypto.createDataKey(db, {
      mode: "crk", crk: orgKey, ownerType: "organisation", ownerId: org.id, purpose: "jd", keyVersion: 1,
    });
    const docAad = vaultCrypto.documentAad("organisation", org.id, doc.dekId, "jd");
    const objectKey = `org/${org.id}/jd/${doc.dekId}`;
    const objectBody = vaultCrypto.encryptDocumentBytes(doc.dek, Buffer.from("%PDF-1.7 synthetic"), docAad);

    const backupKey = backupCrypto.generateBackupKey();
    const archive = backupCrypto.sealBackup(
      backupKey,
      backup.buildBackupPlaintext({
        createdAt: new Date().toISOString(),
        tables: await backup.dumpPublicDatabase(),
        objects: [{ key: objectKey, body: objectBody }],
      }),
    );
    expect(archive.includes(Buffer.from("seeker-secret"))).toBe(false);
    expect(archive.includes(Buffer.from("%PDF-"))).toBe(false);
    expect(() => restore.openBackupArchive(archive, randomBytes(32).toString("base64url"))).toThrow();

    const parsed = restore.openBackupArchive(archive, backupKey.toString("base64url"));
    const { target, client } = await freshTarget();
    const objects = new Map<string, Buffer>();
    const report = await restore.restoreIntoDatabase(client, parsed, {
      truncate: true,
      writeObject: async (key, body) => void objects.set(key, body),
    });
    expect(report.objects).toBe(1);
    expect(report.skippedTables).toEqual([]);
    expect(report.tables.find((table) => table.table === "data_keys")?.rows).toBeGreaterThanOrEqual(5);
    // A second restore must not silently merge into a populated database.
    await expect(restore.restoreIntoDatabase(client, parsed)).rejects.toThrow(/not empty/);

    const restored = drizzle(client, { schema });
    const keyRow = async (id: string) => (await restored.select().from(dataKeys).where(eq(dataKeys.id, id)))[0];
    const vaultRow = async (ownerId: string) => (await restored.select().from(vaultKeys).where(eq(vaultKeys.ownerId, ownerId)))[0];

    const seekerRow = await keyRow(owned.dekId);
    const seekerVault = await vaultRow(candidate.id);
    const seekerDek = store.openOwnerWrap(seekerRow, seekerVault, seekerKey);
    expect(legacyCrypto.aesDecrypt(seekerDek, owned.valueEncrypted).toString()).toBe("seeker-secret");
    expect(() => store.openOwnerWrap(seekerRow, seekerVault, orgKey)).toThrow();

    const sealedDek = store.openOwnerWrap(await keyRow(sealed.dekId), await vaultRow(org.id), orgKey);
    expect(legacyCrypto.aesDecrypt(sealedDek, sealed.valueEncrypted).toString()).toBe("org-sealed");

    const legacyRow = await keyRow(legacy.dekId);
    expect(legacyCrypto.aesDecrypt(legacyCrypto.unwrapLegacyDek(legacyRow.wrappedKey!), legacy.valueEncrypted).toString()).toBe(
      "legacy-value",
    );

    const docDek = store.openOwnerWrap(await keyRow(doc.dekId), await vaultRow(org.id), orgKey);
    expect(vaultCrypto.decryptDocumentBytes(docDek, objects.get(objectKey)!, docAad).toString()).toBe("%PDF-1.7 synthetic");

    // Deletion policy survives the restore: the shredded key is still gone.
    const erasedRow = await keyRow(erased.dekId);
    expect(erasedRow.wrappedKey).toBeNull();
    expect(erasedRow.shreddedAt).not.toBeNull();
    expect(() => store.openOwnerWrap(erasedRow, seekerVault, seekerKey)).toThrow();
    await client.end();
    expect(target.url).not.toBe(process.env.DATABASE_URL);
  });

  it("runs the operator restore script and prints counts without the key", async () => {
    const backup = await import("@/lib/backup");
    const backupCrypto = await import("@/lib/backup-crypto");
    const key = backupCrypto.generateBackupKey().toString("base64url");
    const archive = backupCrypto.sealBackup(
      backupCrypto.decodeBackupKey(key),
      backup.buildBackupPlaintext({ createdAt: new Date().toISOString(), tables: await backup.dumpPublicDatabase(), objects: [] }),
    );
    const dir = await mkdtemp(join(tmpdir(), "rv-restore-"));
    try {
      await writeFile(join(dir, "archive.rvbak"), archive, { mode: 0o600 });
      await writeFile(join(dir, "backup.key"), key, { mode: 0o600 });
      const target = await startTestDatabase();
      targets.push(target);
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/restore-backup.ts", join(dir, "archive.rvbak")], {
        env: { ...process.env, RESTORE_DATABASE_URL: target.url, BACKUP_KEY_FILE: join(dir, "backup.key") },
        timeout: 120_000,
      });
      const summary = JSON.parse(stdout) as { rows: number; tables: number };
      expect(summary.tables).toBeGreaterThan(10);
      expect(summary.rows).toBeGreaterThan(0);
      expect(stdout + stderr).not.toContain(key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
