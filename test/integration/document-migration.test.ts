import { createHash, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { dataKeys, deletionTasks, documentMigrations, documents, walletDocuments } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { startObjectStore, type TestObjectStore } from "./object-store";
import { createCandidateWithVault, createOrgWithVault, samplePdf } from "./fixtures";

/**
 * #27: legacy plaintext objects move to document envelopes through a
 * resumable, verified migration that never loses the only usable copy.
 */

let stopDb: () => Promise<void>;
let store: TestObjectStore;
let db: typeof import("@/db").db;
let migration: typeof import("@/lib/document-migration");
let protect: typeof import("@/lib/document-protect");
let deletion: typeof import("@/lib/deletion-queue");
let storage: typeof import("@/lib/storage");

beforeAll(async () => {
  store = await startObjectStore();
  ({ db, stop: stopDb } = await setupMigratedDatabase());
  migration = await import("@/lib/document-migration");
  protect = await import("@/lib/document-protect");
  deletion = await import("@/lib/deletion-queue");
  storage = await import("@/lib/storage");
});

afterAll(async () => {
  await stopDb?.();
  await store?.stop();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function legacyOrgDoc(orgId: string, kind: "jd" | "evidence", opts: { checksum?: string; scan?: "clean" | "pending" } = {}) {
  const bytes = samplePdf(`LEGACY-${kind}-${randomUUID()}`);
  const key = `org/${orgId}/${randomUUID()}/original-name.pdf`;
  await store.putRaw(key, bytes);
  const [doc] = await db
    .insert(documents)
    .values({
      orgId,
      kind,
      fileName: "original-name.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.length,
      storageKey: key,
      checksum: opts.checksum ?? sha(bytes),
      scanStatus: opts.scan ?? "clean",
    })
    .returning();
  return { doc, bytes, key };
}

async function legacyWalletDoc(candidateAccountId: string) {
  const bytes = samplePdf(`LEGACY-wallet-${randomUUID()}`);
  const key = `wallet/${candidateAccountId}/${randomUUID()}/cv.pdf`;
  await store.putRaw(key, bytes);
  const [doc] = await db
    .insert(walletDocuments)
    .values({
      candidateAccountId,
      kind: "resume",
      fileName: "cv.pdf",
      contentType: "application/pdf",
      storageKey: key,
      checksum: sha(bytes),
      scanStatus: "clean",
    })
    .returning();
  return { doc, bytes, key };
}

async function orgRow(id: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  return { ...row, ownerType: "organisation" as const, ownerId: row.orgId! };
}

describe("legacy document migration", () => {
  it("counts, migrates, verifies, resumes after a mid-batch failure, and cleans up originals", async () => {
    const org = await createOrgWithVault(db);
    const seeker = await createCandidateWithVault(db);
    const unenrolled = await createOrgWithVault(db, { vault: false });
    const jd = await legacyOrgDoc(org.orgId, "jd");
    const evidence = await legacyOrgDoc(org.orgId, "evidence");
    const wallet = await legacyWalletDoc(seeker.candidateAccountId);
    const waiting = await legacyOrgDoc(unenrolled.orgId, "evidence");
    const pending = await legacyOrgDoc(org.orgId, "evidence", { scan: "pending" });

    expect(await migration.countLegacyDocuments()).toEqual({ documents: 3, walletDocuments: 1 });

    // Inject an object-store failure on the second write of the batch.
    let puts = 0;
    const first = await migration.migrateLegacyDocuments({
      store: {
        put: async (key, bytes) => {
          puts += 1;
          if (puts === 2) throw new Error("injected store failure");
          await protect.putProtectedObject(key, bytes);
        },
      },
    });
    expect(first.legacyBefore).toBe(4);
    expect(first.migrated).toBe(2);
    expect(first.awaitingEnrollment).toBe(1);
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(2);

    // The failed document still points at its readable original.
    const stillLegacy = (await db.select().from(documents).where(eq(documents.envelopeVersion, 0)))
      .map((d) => d.id);
    const interrupted = [jd, evidence].find((d) => stillLegacy.includes(d.doc.id))!;
    expect(interrupted).toBeDefined();
    const before = await orgRow(interrupted.doc.id);
    expect(before.storageKey).toBe(interrupted.key);
    expect((await protect.readProtectedDocument(before)).bytes.equals(interrupted.bytes)).toBe(true);

    // Resume (lease expired) migrates the rest; the unenrolled owner waits.
    const second = await migration.migrateLegacyDocuments({ leaseMs: 0 });
    expect(second.migrated).toBe(1);
    expect(second.awaitingEnrollment).toBe(1);
    expect(second.remaining).toBe(1);

    for (const item of [jd, evidence]) {
      const row = await orgRow(item.doc.id);
      expect(row.envelopeVersion).toBe(protect.DOCUMENT_ENVELOPE_VERSION);
      expect(row.storageKey).not.toBe(item.key);
      expect(row.contentType).toBe("application/octet-stream");
      expect(row.originalContentType).toBe("application/pdf");
      const raw = await store.getRaw(row.storageKey);
      expect(raw.includes(Buffer.from("LEGACY-"))).toBe(false);
      const read = await protect.readProtectedDocument(row, { crk: org.crk });
      expect(read.bytes.equals(item.bytes)).toBe(true);
    }
    const jdRow = await orgRow(jd.doc.id);
    expect((await protect.readProtectedDocument(jdRow, { renderDelegation: true })).bytes.equals(jd.bytes)).toBe(true);
    const [evidenceKey] = await db
      .select()
      .from(dataKeys)
      .where(eq(dataKeys.id, (await orgRow(evidence.doc.id)).dekId!));
    expect(evidenceKey.renderWrapped).toBeNull();

    const [w] = await db.select().from(walletDocuments).where(eq(walletDocuments.id, wallet.doc.id));
    const walletRead = await protect.readProtectedDocument(
      { ...w, ownerType: "candidate", ownerId: seeker.candidateAccountId },
      { crk: seeker.crk },
    );
    expect(walletRead.bytes.equals(wallet.bytes)).toBe(true);

    // Originals and the abandoned attempt are queued, then removed.
    for (const key of [jd.key, evidence.key, wallet.key]) {
      const tasks = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, key));
      expect(tasks).toHaveLength(1);
    }
    await deletion.processDeletionTasks(storage.deleteObject, 100);
    for (const key of [jd.key, evidence.key, wallet.key]) expect((await store.keys(key)).length).toBe(0);
    expect((await store.keys(waiting.key)).length).toBe(1);
    expect((await store.keys(pending.key)).length).toBe(1);
    // Exactly one object per migrated document remains under each owner.
    expect(await store.keys(`org/${org.orgId}/`)).toHaveLength(3);
    expect(await store.keys(`wallet/${seeker.candidateAccountId}/`)).toHaveLength(1);

    const totals = await migration.documentMigrationTotals();
    expect(totals.done).toBeGreaterThanOrEqual(3);
  });

  it("never switches a document whose original fails its checksum, and gives up after bounded attempts", async () => {
    const org = await createOrgWithVault(db);
    const bad = await legacyOrgDoc(org.orgId, "evidence", { checksum: "0".repeat(64) });
    let report;
    for (let i = 0; i < 6; i += 1) report = await migration.migrateLegacyDocuments({ leaseMs: 0 });
    const [m] = await db
      .select()
      .from(documentMigrations)
      .where(and(eq(documentMigrations.tableName, "documents"), eq(documentMigrations.documentId, bad.doc.id)));
    expect(m.state).toBe("failed");
    expect(m.lastError).toContain("checksum");
    const row = await orgRow(bad.doc.id);
    expect(row.envelopeVersion).toBe(0);
    expect(row.storageKey).toBe(bad.key);
    expect((await store.getRaw(bad.key)).equals(bad.bytes)).toBe(true);
    // Failed rows are reported separately and no longer counted as remaining.
    expect(report!.remaining).toBe(1); // the unenrolled organisation from the first test
  });

  it("migrates each document exactly once under concurrent workers", async () => {
    const org = await createOrgWithVault(db);
    const docs = await Promise.all(Array.from({ length: 5 }, () => legacyOrgDoc(org.orgId, "evidence")));
    const [a, b] = await Promise.all([
      migration.migrateLegacyDocuments(),
      migration.migrateLegacyDocuments(),
    ]);
    // Both workers see the same documents; each one is migrated by exactly one.
    expect(a.migrated + b.migrated).toBe(5);
    await deletion.processDeletionTasks(storage.deleteObject, 100);
    expect(await store.keys(`org/${org.orgId}/`)).toHaveLength(5);
    for (const d of docs) {
      const row = await orgRow(d.doc.id);
      expect((await protect.readProtectedDocument(row, { crk: org.crk })).bytes.equals(d.bytes)).toBe(true);
    }
  });
});
