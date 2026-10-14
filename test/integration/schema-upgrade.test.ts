import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { randomBytes, randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase, type TestDatabase } from "./harness";

/**
 * Upgrade proof: a database created by the last release before customer
 * vaults (migration 0009) keeps its LOCAL_KEK-encrypted records readable after
 * every later migration is applied.
 */

const LAST_PRE_VAULT = "0009_eminent_spiral";

let database: TestDatabase;
let migrationsDir: string;
let db: typeof import("@/db").db;

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  db = (await import("@/db")).db;

  // A copy of the migrations folder whose journal stops at the old release.
  migrationsDir = mkdtempSync(join(tmpdir(), "rv-upgrade-"));
  cpSync("drizzle", migrationsDir, { recursive: true });
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const cut = journal.entries.findIndex((e: { tag: string }) => e.tag === LAST_PRE_VAULT);
  expect(cut).toBeGreaterThanOrEqual(0);
  journal.entries = journal.entries.slice(0, cut + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
});

afterAll(async () => {
  if (db) await (db.$client as { end: () => Promise<void> }).end();
  await database?.stop();
  if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
});

describe("schema upgrade from the pre-vault release", () => {
  it("applies every later migration and keeps legacy envelopes readable", async () => {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { aesEncrypt, localKek } = await import("@/lib/crypto-legacy");
    await migrate(db, { migrationsFolder: migrationsDir });

    // Rows written the way the 0009-era code wrote them.
    const userId = randomUUID();
    const accountId = randomUUID();
    const dekId = randomUUID();
    const itemId = randomUUID();
    const dek = randomBytes(32);
    const ciphertext = aesEncrypt(dek, Buffer.from("NV1 clearance, held since 2019"));
    await db.execute(sql`insert into "user" (id, name, email, email_verified)
      values (${userId}, 'Upgrade Seeker', ${`${userId}@upgrade.test`}, true)`);
    await db.execute(sql`insert into candidate_accounts (id, user_id) values (${accountId}, ${userId})`);
    await db.execute(sql`insert into data_keys (id, wrapped_key, key_source)
      values (${dekId}, ${aesEncrypt(localKek(), dek)}, 'local')`);
    await db.execute(sql`insert into wallet_items (id, candidate_account_id, type, value_encrypted, dek_id)
      values (${itemId}, ${accountId}, 'clearance', ${ciphertext}, ${dekId})`);

    await migrate(db, { migrationsFolder: "drizzle" });

    const applied = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    expect(applied.rows[0].n).toBe(journal.entries.length);

    const { decryptField } = await import("@/lib/crypto");
    const row = await db.execute(sql`select value_encrypted, dek_id from wallet_items where id = ${itemId}`);
    expect(row.rows).toHaveLength(1);
    const { value_encrypted, dek_id } = row.rows[0] as { value_encrypted: string; dek_id: string };
    expect(await decryptField(value_encrypted, dek_id)).toBe("NV1 clearance, held since 2019");
  });
});
