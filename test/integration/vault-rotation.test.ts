import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  apiKeys,
  candidateAccounts,
  dataKeys,
  organisations,
  requestFields,
  requests,
  submissions,
  submissionValues,
  user,
  vaultKeys,
  vaultRotations,
  walletItems,
} from "@/db/schema";
import { setupMigratedDatabase } from "./harness";

/**
 * Customer-key rotation, cancellation, and legacy migration on real
 * PostgreSQL with two owners and mixed legacy / crk / sealed envelopes.
 * Assertions use counts and versions; the only plaintext is synthetic.
 */

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let crypto: typeof import("@/lib/crypto");
let store: typeof import("@/lib/vault-store");
let rotation: typeof import("@/lib/key-rotation");
let legacy: typeof import("@/lib/vault-legacy-migration");

type Owner = { ownerType: "organisation" | "candidate"; ownerId: string };
type Field = { valueEncrypted: string; dekId: string; plain: string };

async function makeUser(email: string) {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "Synthetic", email, emailVerified: true });
  return id;
}

async function makeOrg() {
  const [org] = await db.insert(organisations).values({ name: "Org", slug: `org-${randomUUID().slice(0, 8)}` }).returning();
  return org.id;
}

async function makeCandidate() {
  const userId = await makeUser(`${randomUUID()}@example.invalid`);
  const [candidate] = await db.insert(candidateAccounts).values({ userId }).returning();
  return candidate.id;
}

async function enroll(owner: Owner) {
  const crk = randomBytes(32);
  await store.insertVaultKey(db, { ...owner, crk });
  return crk;
}

async function versionOf(owner: Owner) {
  return (await store.activeVault(owner.ownerType, owner.ownerId))!;
}

async function crkField(owner: Owner, crk: Buffer, plain: string, purpose = "field"): Promise<Field> {
  const vault = await versionOf(owner);
  const field = await crypto.encryptField(plain, { mode: "crk", crk, ...owner, purpose, keyVersion: vault.version });
  return { ...field, plain };
}

async function sealedField(owner: Owner, plain: string): Promise<Field> {
  const vault = await versionOf(owner);
  const field = await crypto.encryptField(plain, {
    mode: "sealed",
    recipientPublicKey: vault.publicKey,
    ...owner,
    purpose: "submission",
    keyVersion: vault.version,
  });
  return { ...field, plain };
}

async function expectReadable(fields: Field[], crk: Buffer) {
  for (const field of fields) {
    expect(await crypto.decryptField(field.valueEncrypted, field.dekId, { crk })).toBe(field.plain);
  }
}

async function expectUnreadable(fields: Field[], crk: Buffer) {
  for (const field of fields) {
    await expect(crypto.decryptField(field.valueEncrypted, field.dekId, { crk })).rejects.toThrow();
  }
}

async function versionsOf(fields: Field[]) {
  const rows = await db
    .select({ keyVersion: dataKeys.keyVersion })
    .from(dataKeys)
    .where(inArray(dataKeys.id, fields.map((field) => field.dekId)));
  return rows.map((row) => row.keyVersion);
}

async function bridgeCount(owner: Owner) {
  const rows = await db
    .select()
    .from(dataKeys)
    .where(and(eq(dataKeys.ownerId, owner.ownerId), eq(dataKeys.purpose, store.ROTATION_BRIDGE_PURPOSE)));
  return rows.length;
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "44".repeat(32);
  ({ db, stop } = await setupMigratedDatabase());
  crypto = await import("@/lib/crypto");
  store = await import("@/lib/vault-store");
  rotation = await import("@/lib/key-rotation");
  legacy = await import("@/lib/vault-legacy-migration");
});

afterAll(async () => {
  await stop?.();
});

describe("key rotation", () => {
  it("rotates an organisation and a seeker key across interrupted batches without losing a record", async () => {
    const org: Owner = { ownerType: "organisation", ownerId: await makeOrg() };
    const seeker: Owner = { ownerType: "candidate", ownerId: await makeCandidate() };
    const orgOld = await enroll(org);
    const seekerOld = await enroll(seeker);
    const orgFields = [
      ...(await Promise.all([1, 2, 3, 4, 5].map((n) => crkField(org, orgOld, `org-field-${n}`, "document")))),
      ...(await Promise.all([1, 2, 3, 4].map((n) => sealedField(org, `org-sealed-${n}`)))),
    ];
    const seekerFields = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => crkField(seeker, seekerOld, `seeker-${n}`)));
    const legacyField = { ...(await crypto.encryptField("legacy", { mode: "legacy" })), plain: "legacy" };
    const ownerUser = await makeUser(`${randomUUID()}@example.invalid`);
    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        orgId: org.ownerId,
        userId: ownerUser,
        name: "integration",
        keyHash: randomUUID(),
        prefix: "rv_test",
        vaultKeyId: (await versionOf(org)).id,
      })
      .returning();

    for (const [owner, oldKey, fields] of [
      [org, orgOld, orgFields],
      [seeker, seekerOld, seekerFields],
    ] as const) {
      const newKey = randomBytes(32);
      // Boundary 1: stop cleanly after one batch.
      const first = await rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: newKey }, { batchSize: 2, maxBatches: 1 });
      expect(first).toMatchObject({ completed: false, rotated: 2 });
      // Mid-rotation: the active key still reads everything (bridge), the pending key reads moved rows.
      await expectReadable(fields, oldKey);
      expect(await bridgeCount(owner)).toBe(1);

      // Boundary 2: a crash inside the second batch rolls that batch back.
      let batches = 0;
      await expect(
        rotation.rotateVaultKey(
          { ...owner, oldCrk: oldKey, newCrk: newKey },
          {
            batchSize: 2,
            onBatch: () => {
              batches += 1;
              if (batches === 2) throw new Error("simulated worker crash");
            },
          },
        ),
      ).rejects.toThrow("simulated worker crash");
      await expectReadable(fields, oldKey);
      const status = await rotation.rotationStatus(owner);
      expect(status).toMatchObject({ rotated: 4, remaining: fields.length - 4 });

      // A different "new" key cannot hijack the pending rotation.
      await expect(
        rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: randomBytes(32) }),
      ).rejects.toThrow(/different key/);
      // The wrong current key fails closed.
      await expect(rotation.rotateVaultKey({ ...owner, oldCrk: randomBytes(32), newCrk: newKey })).rejects.toThrow(
        /does not match/,
      );

      // Boundary 3: resume to completion.
      const done = await rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: newKey }, { batchSize: 2 });
      expect(done.completed).toBe(true);
      await expectReadable(fields, newKey);
      await expectUnreadable(fields, oldKey);
      expect(new Set(await versionsOf(fields))).toEqual(new Set([2]));
      expect(await bridgeCount(owner)).toBe(0);
      const keys = await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, owner.ownerId));
      expect(keys.find((key) => key.version === 1)).toMatchObject({ status: "retired", privateKeyWrapped: null });
      expect(keys.find((key) => key.version === 2)?.status).toBe("active");
      const [record] = await db.select().from(vaultRotations).where(eq(vaultRotations.ownerId, owner.ownerId));
      expect(record).toMatchObject({ state: "complete", rotatedCount: fields.length });
    }
    expect(await crypto.decryptField(legacyField.valueEncrypted, legacyField.dekId)).toBe("legacy");
    const [revoked] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(revoked.revokedAt).not.toBeNull();
  });

  it("never strands a record written concurrently with the switch", async () => {
    const owner: Owner = { ownerType: "candidate", ownerId: await makeCandidate() };
    const oldKey = await enroll(owner);
    const newKey = randomBytes(32);
    const fields = await Promise.all([1, 2, 3].map((n) => crkField(owner, oldKey, `before-${n}`)));
    await rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: newKey }, { batchSize: 1, maxBatches: 1 });

    // A writer holds its insert open on the old version while the rotation tries to switch.
    const vault = await versionOf(owner);
    let late: Field | undefined;
    const writer = db.transaction(async (tx) => {
      const { dekId, dek } = await crypto.createDataKey(tx, {
        mode: "crk",
        crk: oldKey,
        ...owner,
        purpose: "field",
        keyVersion: vault.version,
      });
      late = { valueEncrypted: await crypto.encryptFieldWithKey("written-during-switch", dek), dekId, plain: "written-during-switch" };
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const rotate = new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
      rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: newKey }),
    );
    const [, result] = await Promise.all([writer, rotate]);
    expect(result.completed).toBe(true);
    // The switch waited for the writer, found its row, and rotated it too.
    expect(result.rotated).toBe(3);
    await expectReadable([...fields, late!], newKey);

    // After the switch an old-version write fails instead of landing on the retired key.
    await expect(
      crypto.encryptField("too-late", { mode: "crk", crk: oldKey, ...owner, purpose: "field", keyVersion: vault.version }),
    ).rejects.toThrow(/encryption key changed/);
  });

  it("cancels a pending rotation with only the current key", async () => {
    const owner: Owner = { ownerType: "organisation", ownerId: await makeOrg() };
    const oldKey = await enroll(owner);
    const lostKey = randomBytes(32);
    const fields = [
      ...(await Promise.all([1, 2, 3].map((n) => crkField(owner, oldKey, `c-${n}`)))),
      await sealedField(owner, "c-sealed"),
    ];
    await rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: lostKey }, { batchSize: 2, maxBatches: 1 });
    await expect(rotation.cancelVaultRotation({ ...owner, crk: randomBytes(32) })).rejects.toThrow(/does not match/);
    const cancelled = await rotation.cancelVaultRotation({ ...owner, crk: oldKey }, { batchSize: 1 });
    expect(cancelled).toMatchObject({ cancelled: true, restored: 2 });
    await expectReadable(fields, oldKey);
    expect(new Set(await versionsOf(fields))).toEqual(new Set([1]));
    expect(await bridgeCount(owner)).toBe(0);
    expect((await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, owner.ownerId))).map((k) => k.status)).toEqual(["active"]);
    const next = randomBytes(32);
    expect((await rotation.rotateVaultKey({ ...owner, oldCrk: oldKey, newCrk: next })).completed).toBe(true);
    await expectReadable(fields, next);
  });

  it("fails closed on a wrong owner, version, key, damaged ciphertext, or modified metadata", async () => {
    const a: Owner = { ownerType: "candidate", ownerId: await makeCandidate() };
    const b: Owner = { ownerType: "candidate", ownerId: await makeCandidate() };
    const keyA = await enroll(a);
    const keyB = await enroll(b);
    const tamper = async (change: Partial<typeof dataKeys.$inferInsert>) => {
      const field = await crkField(a, keyA, "guarded");
      await db.update(dataKeys).set(change).where(eq(dataKeys.id, field.dekId));
      return field;
    };
    await expectUnreadable([await crkField(a, keyA, "x")], keyB); // wrong key
    await expectUnreadable([await crkField(a, keyA, "x")], randomBytes(32));
    for (const field of [
      await tamper({ ownerId: b.ownerId }), // moved to another owner
      await tamper({ keyVersion: 2 }), // wrong version
      await tamper({ purpose: "other" }), // modified metadata
      await tamper({ ownerType: "organisation" }),
    ]) {
      await expectUnreadable([field], keyA);
      await expectUnreadable([field], keyB);
    }
    const damaged = await crkField(a, keyA, "x");
    const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, damaged.dekId));
    const flipped = row.wrappedKey!.slice(0, -2) + (row.wrappedKey!.endsWith("A") ? "BB" : "AA");
    await db.update(dataKeys).set({ wrappedKey: flipped }).where(eq(dataKeys.id, damaged.dekId));
    await expectUnreadable([damaged], keyA);
    const shredded = await crkField(a, keyA, "x");
    await crypto.shredDataKey(shredded.dekId);
    await expectUnreadable([shredded], keyA);
  });
});

describe("legacy LOCAL_KEK migration", () => {
  it("rewraps legacy field keys resumably while keeping them readable", async () => {
    const seeker: Owner = { ownerType: "candidate", ownerId: await makeCandidate() };
    const orgId = await makeOrg();
    const org: Owner = { ownerType: "organisation", ownerId: orgId };
    const seekerKey = await enroll(seeker);
    const orgKey = await enroll(org);

    const wallet: Field[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const field = await crypto.encryptField(`legacy-wallet-${n}`, { mode: "legacy" });
      await db.insert(walletItems).values({ candidateAccountId: seeker.ownerId, type: `type_${n}`, ...field });
      wallet.push({ ...field, plain: `legacy-wallet-${n}` });
    }
    const creator = await makeUser(`${randomUUID()}@example.invalid`);
    const [request] = await db.insert(requests).values({ orgId, createdBy: creator, title: "Role" }).returning();
    const [field] = await db
      .insert(requestFields)
      .values({ requestId: request.id, key: "custom", type: "short_text", label: "Q" })
      .returning();
    const answers: Field[] = [];
    let draft: Field | undefined;
    for (const status of ["received", "received", "started"] as const) {
      const [submission] = await db.insert(submissions).values({ requestId: request.id, status }).returning();
      const encrypted = await crypto.encryptField(`answer-${status}`, { mode: "legacy" });
      await db.insert(submissionValues).values({ submissionId: submission.id, fieldId: field.id, ...encrypted });
      if (status === "started") draft = { ...encrypted, plain: `answer-${status}` };
      else answers.push({ ...encrypted, plain: `answer-${status}` });
    }
    expect(await legacy.countLegacyDataKeys(seeker)).toBe(5);
    expect(await legacy.countLegacyDataKeys(org)).toBe(2);

    const partial = await legacy.migrateLegacyDataKeys({ ...seeker, crk: seekerKey }, { batchSize: 2, maxBatches: 1 });
    expect(partial).toEqual({ migrated: 2, remaining: 3 });
    await expectReadable(wallet, seekerKey); // migrated via the customer key, the rest via LOCAL_KEK
    await expect(
      legacy.migrateLegacyDataKeys(
        { ...seeker, crk: seekerKey },
        { batchSize: 2, onBatch: () => Promise.reject(new Error("simulated crash")) },
      ),
    ).rejects.toThrow("simulated crash");
    expect(await legacy.countLegacyDataKeys(seeker)).toBe(3);
    await expect(legacy.migrateLegacyDataKeys({ ...seeker, crk: orgKey })).rejects.toThrow(/does not match/);
    expect(await legacy.migrateLegacyDataKeys({ ...seeker, crk: seekerKey }, { batchSize: 2 })).toEqual({
      migrated: 3,
      remaining: 0,
    });
    await expectReadable(wallet, seekerKey);
    await expectUnreadable(wallet, orgKey);
    // Idempotent.
    expect(await legacy.migrateLegacyDataKeys({ ...seeker, crk: seekerKey })).toEqual({ migrated: 0, remaining: 0 });

    expect(await legacy.migrateLegacyDataKeys({ ...org, crk: orgKey })).toEqual({ migrated: 2, remaining: 0 });
    await expectReadable(answers, orgKey);
    // The open draft keeps its legacy wrap for the link responder.
    expect(await crypto.decryptField(draft!.valueEncrypted, draft!.dekId)).toBe(draft!.plain);

    // Migrated keys rotate like any other customer key.
    const next = randomBytes(32);
    expect((await rotation.rotateVaultKey({ ...seeker, oldCrk: seekerKey, newCrk: next })).completed).toBe(true);
    await expectReadable(wallet, next);
  });
});
