import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupMigratedDatabase } from "./harness";

/**
 * End-to-end envelope encryption against a real Postgres. Exercises the DEK
 * registry, unwrap, and crypto-shred paths that pure unit tests can't reach.
 * Uses the LOCAL_KEK wrap path (no KMS_KEY_ID) so no AWS credentials needed.
 */

let stop: () => Promise<void>;
let db: typeof import("@/db").db;
// Loaded after DATABASE_URL is set so @/db binds to the test database.
let crypto: typeof import("@/lib/crypto");

beforeAll(async () => {
  ({ db, stop } = await setupMigratedDatabase());
  crypto = await import("@/lib/crypto");
});

afterAll(async () => {
  await stop?.();
});

describe("envelope encryption + crypto-shred", () => {
  it("round-trips a field through createDataKey / getDataKey", async () => {
    const { valueEncrypted, dekId } = await crypto.encryptField("0412 345 678", { mode: "legacy" });
    expect(await crypto.decryptField(valueEncrypted, dekId)).toBe("0412 345 678");
  });

  it("returns the same key material on repeated unwrap", async () => {
    const { dekId, dek } = await crypto.createDataKey(db, { mode: "legacy" });
    const again = await crypto.getDataKey(dekId);
    expect(again.equals(dek)).toBe(true);
  });

  it("makes ciphertext unrecoverable after crypto-shred", async () => {
    const { valueEncrypted, dekId } = await crypto.encryptField("sensitive", { mode: "legacy" });
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
