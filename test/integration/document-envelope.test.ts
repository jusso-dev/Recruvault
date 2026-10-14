import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { dataKeys, deletionTasks, documents, walletDocuments } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { startObjectStore, type TestObjectStore } from "./object-store";
import {
  createCandidateWithVault,
  createOrgWithVault,
  sampleDocx,
  samplePdf,
  samplePng,
} from "./fixtures";

/**
 * #27: document envelopes against real PostgreSQL and an isolated S3 store.
 * Raw objects must never contain the original bytes; reads must fail closed.
 */

let stopDb: () => Promise<void>;
let store: TestObjectStore;
let db: typeof import("@/db").db;
let protect: typeof import("@/lib/document-protect");
let crypto: typeof import("@/lib/crypto");
let vaultCrypto: typeof import("@/lib/vault-crypto");
let watermark: typeof import("@/lib/watermark");
let fields: typeof import("@/lib/fields");

const clean = async () => "clean" as const;

beforeAll(async () => {
  store = await startObjectStore();
  ({ db, stop: stopDb } = await setupMigratedDatabase());
  protect = await import("@/lib/document-protect");
  crypto = await import("@/lib/crypto");
  vaultCrypto = await import("@/lib/vault-crypto");
  watermark = await import("@/lib/watermark");
  fields = await import("@/lib/fields");
});

afterAll(async () => {
  await stopDb?.();
  await store?.stop();
});

async function uploadOrgDocument(
  org: Awaited<ReturnType<typeof createOrgWithVault>>,
  kind: "jd" | "evidence",
  bytes: Buffer,
  contentType = "application/pdf",
) {
  const prepared = await protect.protectDocument({
    executor: db,
    bytes,
    ownerType: "organisation",
    ownerId: org.orgId,
    purpose: kind,
    keyVersion: org.vault!.version,
    recipientPublicKey: org.vault!.publicKey,
    scope: "org",
    scan: clean,
  });
  if (!prepared.ok) throw new Error(prepared.error);
  await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
  const [doc] = await db
    .insert(documents)
    .values({
      id: prepared.documentId,
      orgId: org.orgId,
      kind,
      fileName: "file.bin",
      contentType: "application/octet-stream",
      originalContentType: contentType,
      sizeBytes: bytes.length,
      storageKey: prepared.storageKey,
      dekId: prepared.dekId,
      envelopeVersion: prepared.envelopeVersion,
      scanStatus: "clean",
    })
    .returning();
  return { ...doc, ownerType: "organisation" as const, ownerId: org.orgId };
}

async function uploadWalletDocument(
  owner: Awaited<ReturnType<typeof createCandidateWithVault>>,
  bytes: Buffer,
  kind = "resume",
) {
  const prepared = await protect.protectDocument({
    executor: db,
    bytes,
    ownerType: "candidate",
    ownerId: owner.candidateAccountId,
    purpose: kind,
    keyVersion: owner.vault.version,
    crk: owner.crk,
    scope: "wallet",
    scan: clean,
  });
  if (!prepared.ok) throw new Error(prepared.error);
  await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
  const [doc] = await db
    .insert(walletDocuments)
    .values({
      id: prepared.documentId,
      candidateAccountId: owner.candidateAccountId,
      kind,
      fileName: "resume.pdf",
      contentType: "application/octet-stream",
      originalContentType: "application/pdf",
      storageKey: prepared.storageKey,
      dekId: prepared.dekId,
      envelopeVersion: prepared.envelopeVersion,
      scanStatus: "clean",
    })
    .returning();
  return { ...doc, ownerType: "candidate" as const, ownerId: owner.candidateAccountId };
}

describe("document envelopes", () => {
  it("stores only ciphertext for JD, evidence, and wallet uploads and round-trips them", async () => {
    const org = await createOrgWithVault(db);
    const seeker = await createCandidateWithVault(db);
    const cases = [
      { label: "jd", marker: `JD-${randomUUID()}` },
      { label: "evidence-png", marker: `PNG-${randomUUID()}` },
      { label: "evidence-docx", marker: `DOCX-${randomUUID()}` },
      { label: "wallet", marker: `WALLET-${randomUUID()}` },
    ];
    const jdBytes = samplePdf(cases[0].marker);
    const pngBytes = samplePng(cases[1].marker);
    const docxBytes = sampleDocx(cases[2].marker);
    const walletBytes = samplePdf(cases[3].marker);

    const jd = await uploadOrgDocument(org, "jd", jdBytes);
    const png = await uploadOrgDocument(org, "evidence", pngBytes, "image/png");
    const docx = await uploadOrgDocument(org, "evidence", docxBytes, fields.JD_ALLOWED_TYPES[1]);
    const wallet = await uploadWalletDocument(seeker, walletBytes);

    for (const [doc, c] of [
      [jd, cases[0]],
      [png, cases[1]],
      [docx, cases[2]],
      [wallet, cases[3]],
    ] as const) {
      const raw = await store.getRaw(doc.storageKey);
      expect(raw.includes(Buffer.from(c.marker)), c.label).toBe(false);
      expect(raw.includes(Buffer.from("%PDF")), c.label).toBe(false);
      expect(raw.includes(Buffer.from("word/")), c.label).toBe(false);
      expect(doc.storageKey).not.toContain(".");
      expect(doc.envelopeVersion).toBe(protect.DOCUMENT_ENVELOPE_VERSION);
    }

    const orgCrk = { crk: org.crk };
    expect((await protect.readProtectedDocument(jd, orgCrk)).bytes.equals(jdBytes)).toBe(true);
    expect((await protect.readProtectedDocument(png, orgCrk)).bytes.equals(pngBytes)).toBe(true);
    expect((await protect.readProtectedDocument(docx, orgCrk)).bytes.equals(docxBytes)).toBe(true);
    const walletRead = await protect.readProtectedDocument(wallet, { crk: seeker.crk });
    expect(walletRead.bytes.equals(walletBytes)).toBe(true);
    expect(walletRead.contentType).toBe("application/pdf");
  });

  it("render-delegates JDs only, never candidate evidence or wallet files", async () => {
    const org = await createOrgWithVault(db);
    const seeker = await createCandidateWithVault(db);
    const jd = await uploadOrgDocument(org, "jd", samplePdf("render-jd"));
    const evidence = await uploadOrgDocument(org, "evidence", samplePdf("render-evidence"));
    const wallet = await uploadWalletDocument(seeker, samplePdf("render-wallet"));

    const keyRow = async (id: string) =>
      (await db.select().from(dataKeys).where(eq(dataKeys.id, id)))[0];
    expect((await keyRow(jd.dekId!)).renderWrapped).not.toBeNull();
    expect((await keyRow(evidence.dekId!)).renderWrapped).toBeNull();
    expect((await keyRow(wallet.dekId!)).renderWrapped).toBeNull();

    const delegated = await protect.readProtectedDocument(jd, { renderDelegation: true });
    expect(delegated.bytes.toString("latin1")).toContain("render-jd");
    await expect(
      protect.readProtectedDocument(evidence, { renderDelegation: true }),
    ).rejects.toMatchObject({ reason: "locked" });
  });

  it("rejects tampered ciphertext, swapped context, and cross-owner keys", async () => {
    const orgA = await createOrgWithVault(db);
    const orgB = await createOrgWithVault(db);
    const seekerA = await createCandidateWithVault(db);
    const seekerB = await createCandidateWithVault(db);
    const doc = await uploadOrgDocument(orgA, "evidence", samplePdf("tamper"));
    const wallet = await uploadWalletDocument(seekerA, samplePdf("tamper-wallet"));

    // Flip one ciphertext character in storage.
    const raw = await store.getRaw(doc.storageKey);
    const tampered = Buffer.from(raw);
    const at = tampered.length - 5;
    tampered[at] = tampered[at] === 0x41 ? 0x42 : 0x41;
    const tamperedKey = `org/${orgA.orgId}/${randomUUID()}`;
    await store.putRaw(tamperedKey, tampered);
    await expect(
      protect.readProtectedDocument({ ...doc, storageKey: tamperedKey }, { crk: orgA.crk }),
    ).rejects.toMatchObject({ reason: "integrity" });

    // Same object presented as another document, kind, or envelope version.
    await expect(
      protect.readProtectedDocument({ ...doc, id: randomUUID() }, { crk: orgA.crk }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      protect.readProtectedDocument({ ...doc, kind: "jd" }, { crk: orgA.crk }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      protect.readProtectedDocument({ ...doc, envelopeVersion: 1 }, { crk: orgA.crk }),
    ).rejects.toMatchObject({ reason: "integrity" });

    // Another owner's key, and another owner claiming the document.
    await expect(
      protect.readProtectedDocument(doc, { crk: orgB.crk }),
    ).rejects.toBeInstanceOf(protect.DocumentAccessError);
    await expect(
      protect.readProtectedDocument({ ...doc, ownerId: orgB.orgId }, { crk: orgB.crk }),
    ).rejects.toBeInstanceOf(protect.DocumentAccessError);
    await expect(
      protect.readProtectedDocument(wallet, { crk: seekerB.crk }),
    ).rejects.toBeInstanceOf(protect.DocumentAccessError);
    await expect(
      protect.readProtectedDocument({ ...wallet, ownerId: seekerB.candidateAccountId }, { crk: seekerB.crk }),
    ).rejects.toBeInstanceOf(protect.DocumentAccessError);
  });

  it("makes a retained object unreadable once its key is shredded, including the render wrap", async () => {
    const org = await createOrgWithVault(db);
    const jd = await uploadOrgDocument(org, "jd", samplePdf("shred-me"));
    await crypto.shredDataKey(jd.dekId!);

    const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, jd.dekId!));
    expect(row.wrappedKey).toBeNull();
    expect(row.renderWrapped).toBeNull();
    expect(row.shreddedAt).not.toBeNull();
    // The ciphertext is still in storage, but nothing can open it.
    expect((await store.getRaw(jd.storageKey)).length).toBeGreaterThan(0);
    await expect(
      protect.readProtectedDocument(jd, { crk: org.crk }),
    ).rejects.toMatchObject({ reason: "shredded" });
    await expect(
      protect.readProtectedDocument(jd, { renderDelegation: true }),
    ).rejects.toMatchObject({ reason: "shredded" });
  });

  it("keeps v1 envelopes and legacy plaintext readable", async () => {
    const org = await createOrgWithVault(db);
    const bytes = samplePdf("v1-envelope");
    const { dekId, dek } = await crypto.createDataKey(db, {
      mode: "crk",
      crk: org.crk,
      ownerType: "organisation",
      ownerId: org.orgId,
      purpose: "jd",
      keyVersion: 1,
    });
    const id = randomUUID();
    const key = `org/${org.orgId}/${randomUUID()}`;
    await store.putRaw(
      key,
      vaultCrypto.encryptDocumentBytes(dek, bytes, vaultCrypto.documentAad("organisation", org.orgId, id, "bytes")),
    );
    const v1 = {
      id,
      storageKey: key,
      envelopeVersion: 1,
      dekId,
      kind: "jd",
      contentType: "application/octet-stream",
      originalContentType: "application/pdf",
      ownerType: "organisation" as const,
      ownerId: org.orgId,
    };
    expect((await protect.readProtectedDocument(v1, { crk: org.crk })).bytes.equals(bytes)).toBe(true);

    const legacyKey = `org/${org.orgId}/${randomUUID()}/legacy.pdf`;
    await store.putRaw(legacyKey, bytes);
    const legacy = { ...v1, storageKey: legacyKey, envelopeVersion: 0, dekId: null, contentType: "application/pdf" };
    expect((await protect.readProtectedDocument(legacy)).bytes.equals(bytes)).toBe(true);
  });

  it("refuses infected files and an unavailable scanner before creating a key or object", async () => {
    const org = await createOrgWithVault(db);
    const before = (await db.select().from(dataKeys)).length;
    const objectsBefore = (await store.keys(`org/${org.orgId}/`)).length;
    for (const verdict of ["infected", "error"] as const) {
      const result = await protect.protectDocument({
        executor: db,
        bytes: samplePdf("eicar-like"),
        ownerType: "organisation",
        ownerId: org.orgId,
        purpose: "evidence",
        keyVersion: 1,
        recipientPublicKey: org.vault!.publicKey,
        scope: "org",
        scan: async () => verdict,
      });
      expect(result.ok).toBe(false);
    }
    expect((await db.select().from(dataKeys)).length).toBe(before);
    expect((await store.keys(`org/${org.orgId}/`)).length).toBe(objectsBefore);
  });

  it("watermarks a decrypted PDF and round-trips a maximum-size upload", async () => {
    const org = await createOrgWithVault(db);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const marker = `WM-${randomUUID()}`;
    const pdfBytes = Buffer.concat([Buffer.from(await pdf.save()), Buffer.from(`% ${marker}\n`)]);
    expect(pdfBytes.includes(Buffer.from(marker))).toBe(true);
    const doc = await uploadOrgDocument(org, "jd", pdfBytes);
    expect((await store.getRaw(doc.storageKey)).includes(Buffer.from(marker))).toBe(false);
    const opened = await protect.readProtectedDocument(doc, { renderDelegation: true });
    const stamped = await watermark.watermarkPdf(opened.bytes, "viewer · test");
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(1);

    const big = Buffer.concat([samplePdf("max-size"), randomBytes(fields.UPLOAD_MAX_BYTES - 200)]);
    const large = await uploadOrgDocument(org, "evidence", big);
    expect((await protect.readProtectedDocument(large, { crk: org.crk })).bytes.equals(big)).toBe(true);
  });

  it("discards an uncommitted upload by shredding its key and queueing its object", async () => {
    const org = await createOrgWithVault(db);
    const prepared = await protect.protectDocument({
      executor: db,
      bytes: samplePdf("discard"),
      ownerType: "organisation",
      ownerId: org.orgId,
      purpose: "evidence",
      keyVersion: 1,
      recipientPublicKey: org.vault!.publicKey,
      scope: "org",
      scan: clean,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
    await protect.discardProtectedUploads(
      [{ storageKey: prepared.storageKey, dekId: prepared.dekId }],
      org.orgId,
    );
    const [key] = await db.select().from(dataKeys).where(eq(dataKeys.id, prepared.dekId));
    expect(key.shreddedAt).not.toBeNull();
    const tasks = await db
      .select()
      .from(deletionTasks)
      .where(eq(deletionTasks.storageKey, prepared.storageKey));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].state).toBe("pending");
  });
});
