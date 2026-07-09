import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * End-to-end envelope encryption against a real Postgres. Exercises the DEK
 * registry, unwrap, and crypto-shred paths that pure unit tests can't reach.
 * Uses the LOCAL_KEK wrap path (no KMS_KEY_ID) so no AWS credentials needed.
 */

let container: StartedPostgreSqlContainer;
// Loaded after DATABASE_URL is set so @/db binds to the container.
let crypto: typeof import("@/lib/crypto");

beforeAll(async () => {
  delete process.env.KMS_KEY_ID; // force the local-KEK wrap path
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.DATABASE_URL = container.getConnectionUri();

  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: "drizzle" });

  crypto = await import("@/lib/crypto");
});

afterAll(async () => {
  // Close the pg pool before killing the container, otherwise idle
  // connections surface as a FATAL 57P01 "terminating connection" unhandled
  // error when Postgres shuts down under them.
  const { db } = await import("@/db");
  await (db.$client as { end: () => Promise<void> }).end();
  await container?.stop();
});

describe("envelope encryption + crypto-shred", () => {
  it("round-trips a field through createDataKey / getDataKey", async () => {
    const { valueEncrypted, dekId } = await crypto.encryptField("0412 345 678");
    expect(await crypto.decryptField(valueEncrypted, dekId)).toBe("0412 345 678");
  });

  it("returns the same key material on repeated unwrap", async () => {
    const { dekId, dek } = await crypto.createDataKey();
    const again = await crypto.getDataKey(dekId);
    expect(again.equals(dek)).toBe(true);
  });

  it("makes ciphertext unrecoverable after crypto-shred", async () => {
    const { valueEncrypted, dekId } = await crypto.encryptField("sensitive");
    await crypto.shredDataKey(dekId);
    await expect(crypto.getDataKey(dekId)).rejects.toThrow("shredded");
    await expect(crypto.decryptField(valueEncrypted, dekId)).rejects.toThrow("shredded");
  });

  it("throws for an unknown DEK id", async () => {
    await expect(
      crypto.getDataKey("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("not found");
  });
});
