import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deletionTasks, outboxEvents } from "@/db/schema";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer;
let db: typeof import("@/db").db;
let crypto: typeof import("@/lib/crypto");
let vault: typeof import("@/lib/vault-store");
let rotation: typeof import("@/lib/key-rotation");
let outbox: typeof import("@/lib/outbox");
let deletion: typeof import("@/lib/deletion-queue");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.LOCAL_KEK = "11".repeat(32);

  db = (await import("@/db")).db;
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: "drizzle" });
  crypto = await import("@/lib/crypto");
  vault = await import("@/lib/vault-store");
  rotation = await import("@/lib/key-rotation");
  outbox = await import("@/lib/outbox");
  deletion = await import("@/lib/deletion-queue");
});

afterAll(async () => {
  if (db) await (db.$client as { end: () => Promise<void> }).end();
  await container?.stop();
});

describe("customer vault on postgres", () => {
  it("keeps a legacy envelope readable and fails a cross-owner unwrap", async () => {
    const legacy = await crypto.encryptField("legacy-value");
    expect(await crypto.decryptField(legacy.valueEncrypted, legacy.dekId)).toBe("legacy-value");

    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    await vault.insertVaultKey(db, { ownerType: "organisation", ownerId: ownerA, crk: keyA });
    await vault.insertVaultKey(db, { ownerType: "organisation", ownerId: ownerB, crk: keyB });
    const sealed = await crypto.encryptField("shared", {
      mode: "sealed",
      recipientPublicKey: (await vault.activeVault("organisation", ownerA))!.publicKey,
      ownerType: "organisation",
      ownerId: ownerA,
      purpose: "submission",
      keyVersion: 1,
    });
    expect(await crypto.decryptField(sealed.valueEncrypted, sealed.dekId, { crk: keyA })).toBe("shared");
    await expect(crypto.decryptField(sealed.valueEncrypted, sealed.dekId, { crk: keyB })).rejects.toThrow();
  });

  it("resumes rotation without losing the field", async () => {
    const ownerId = randomUUID();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await vault.insertVaultKey(db, { ownerType: "candidate", ownerId, crk: oldKey });
    const field = await crypto.encryptField("clearance", {
      mode: "crk",
      crk: oldKey,
      ownerType: "candidate",
      ownerId,
      purpose: "clearance",
      keyVersion: 1,
    });
    const first = await rotation.rotateVaultKey({
      ownerType: "candidate",
      ownerId,
      oldCrk: oldKey,
      newCrk: newKey,
    });
    expect(first.completed).toBe(true);
    expect(await crypto.decryptField(field.valueEncrypted, field.dekId, { crk: newKey })).toBe("clearance");
    await expect(crypto.decryptField(field.valueEncrypted, field.dekId, { crk: oldKey })).rejects.toThrow();
  });

  it("publishes an outbox row once and retries a failed delete", async () => {
    const dedupe = `security:${randomUUID()}`;
    let sends = 0;
    await outbox.enqueueEvent(db, "submission/received", { submissionId: randomUUID() }, dedupe, "owner");
    await outbox.publishPendingOutbox(async () => {
      sends += 1;
      if (sends === 1) throw new Error("network down user@example.com");
    });
    const [pending] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, dedupe));
    expect(pending.state).toBe("pending");
    expect(pending.lastError ?? "").not.toContain("user@example.com");
    await db.update(outboxEvents).set({ availableAt: new Date(0) }).where(eq(outboxEvents.id, pending.id));
    await outbox.publishPendingOutbox(async () => {
      sends += 1;
    });
    const [done] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, dedupe));
    expect(done.state).toBe("published");

    const storageKey = `org/${randomUUID()}`;
    await deletion.enqueueDeletion(db, storageKey, "owner");
    let attempts = 0;
    await deletion.processDeletionTasks(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
    });
    await db
      .update(deletionTasks)
      .set({ availableAt: new Date(0) })
      .where(eq(deletionTasks.storageKey, storageKey));
    await deletion.processDeletionTasks(async () => {
      attempts += 1;
    });
    const tasks = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, storageKey));
    expect(tasks[0]?.state).toBe("done");
    expect(attempts).toBe(2);
  });
});
