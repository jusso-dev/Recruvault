import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  account,
  accessTokens,
  candidateAccounts,
  candidateApiKeys,
  dataKeys,
  deletionTasks,
  discoveryProfiles,
  documents,
  auditEvents,
  erasureRecords,
  passkey,
  savedRoles,
  session,
  submissionDocuments,
  submissions,
  submissionValues,
  user,
  vaultKeys,
  verification,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { startObjectStore, type TestObjectStore } from "./object-store";
import {
  createCandidateWithVault,
  createOrgWithVault,
  createRequestWithLink,
  createSubmission,
  samplePdf,
} from "./fixtures";

/**
 * #29: purge, erasure, the durable deletion queue, and the reconciler against
 * real PostgreSQL and an isolated S3 store, with injected storage failures and
 * an interrupted erasure.
 */

let stopDb: () => Promise<void>;
let store: TestObjectStore;
let db: typeof import("@/db").db;
let protect: typeof import("@/lib/document-protect");
let crypto: typeof import("@/lib/crypto");
let retention: typeof import("@/lib/retention");
let deletion: typeof import("@/lib/deletion-queue");
let reconciler: typeof import("@/lib/storage-reconciler");
let storage: typeof import("@/lib/storage");
let authModule: typeof import("@/lib/auth");

const clean = async () => "clean" as const;
const DAY = 86_400_000;

beforeAll(async () => {
  store = await startObjectStore();
  ({ db, stop: stopDb } = await setupMigratedDatabase());
  protect = await import("@/lib/document-protect");
  crypto = await import("@/lib/crypto");
  retention = await import("@/lib/retention");
  deletion = await import("@/lib/deletion-queue");
  reconciler = await import("@/lib/storage-reconciler");
  storage = await import("@/lib/storage");
  authModule = await import("@/lib/auth");
});

afterAll(async () => {
  await stopDb?.();
  await store?.stop();
});

async function objectExists(key: string) {
  return (await store.keys(key)).includes(key);
}

async function storeEvidence(
  org: Awaited<ReturnType<typeof createOrgWithVault>>,
  link: { fieldId: string },
  submissionId: string,
) {
  const prepared = await protect.protectDocument({
    executor: db,
    bytes: samplePdf(`evidence-${randomUUID()}`),
    ownerType: "organisation",
    ownerId: org.orgId,
    purpose: "evidence",
    keyVersion: org.vault!.version,
    recipientPublicKey: org.vault!.publicKey,
    scope: "org",
    scan: clean,
  });
  if (!prepared.ok) throw new Error(prepared.error);
  await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
  await db.insert(documents).values({
    id: prepared.documentId,
    orgId: org.orgId,
    kind: "evidence",
    fileName: "evidence.pdf",
    contentType: "application/octet-stream",
    originalContentType: "application/pdf",
    storageKey: prepared.storageKey,
    dekId: prepared.dekId,
    envelopeVersion: prepared.envelopeVersion,
    scanStatus: "clean",
  });
  await db.insert(submissionDocuments).values({
    submissionId,
    fieldId: link.fieldId,
    documentId: prepared.documentId,
  });
  return { storageKey: prepared.storageKey, dekId: prepared.dekId, documentId: prepared.documentId };
}

async function storeValue(
  org: Awaited<ReturnType<typeof createOrgWithVault>>,
  link: { textFieldId: string },
  submissionId: string,
) {
  const { valueEncrypted, dekId } = await crypto.encryptField("synthetic answer", {
    mode: "sealed",
    recipientPublicKey: org.vault!.publicKey,
    ownerType: "organisation",
    ownerId: org.orgId,
    purpose: "submission",
    keyVersion: org.vault!.version,
  });
  await db.insert(submissionValues).values({ submissionId, fieldId: link.textFieldId, valueEncrypted, dekId });
  return dekId;
}

async function isShredded(dekId: string) {
  const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, dekId));
  return !!row?.shreddedAt && row.wrappedKey === null && row.renderWrapped === null;
}

describe("submission purge", () => {
  it("shreds field and document keys, queues and deletes objects, and records progress", async () => {
    const org = await createOrgWithVault(db);
    const link = await createRequestWithLink(db, org);
    const submissionId = await createSubmission(db, link);
    const valueDek = await storeValue(org, link, submissionId);
    const evidence = await storeEvidence(org, link, submissionId);

    await retention.purgeSubmission(submissionId, { actorType: "system" });

    expect(await isShredded(valueDek)).toBe(true);
    expect(await isShredded(evidence.dekId)).toBe(true);
    expect(await db.select().from(documents).where(eq(documents.id, evidence.documentId))).toHaveLength(0);
    const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(sub.purgedAt).not.toBeNull();
    expect(sub.responderEmail).toBeNull();
    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.id, link.accessTokenId));
    expect(token.recipientEmail).not.toContain("@");

    const [record] = await db
      .select()
      .from(erasureRecords)
      .where(and(eq(erasureRecords.subjectType, "submission"), eq(erasureRecords.subjectId, submissionId)));
    const tasks = await db.select().from(deletionTasks).where(eq(deletionTasks.erasureId, record.id));
    expect(tasks.map((t) => [t.storageKey, t.state])).toEqual([[evidence.storageKey, "done"]]);
    expect(await objectExists(evidence.storageKey)).toBe(false);
    expect(record.accessRevokedAt && record.keysShreddedAt && record.cleanupPendingAt).toBeTruthy();
    expect(record.cleanupFinishedAt).not.toBeNull();
    expect(record.objectsQueued).toBe(1);

    // Safe to repeat: no second record, no new tasks.
    await retention.purgeSubmission(submissionId, { actorType: "system" });
    expect(await db.select().from(deletionTasks).where(eq(deletionTasks.erasureId, record.id))).toHaveLength(1);
    expect(
      await db.select().from(erasureRecords).where(eq(erasureRecords.subjectId, submissionId)),
    ).toHaveLength(1);
  });

  it("keeps cleanup pending through an S3 outage, then a retry removes the object without restoring access", async () => {
    const org = await createOrgWithVault(db);
    const link = await createRequestWithLink(db, org);
    const submissionId = await createSubmission(db, link);
    const evidence = await storeEvidence(org, link, submissionId);

    // Simulate the outage by pointing the inline delete at a failing store.
    const realDelete = storage.deleteObject;
    const failing = Object.assign(new Error("connect ECONNREFUSED"), { $metadata: { httpStatusCode: 503 } });
    const outage = await (async () => {
      const [rec] = await db
        .insert(erasureRecords)
        .values({ subjectType: "test-outage", subjectId: submissionId })
        .returning();
      return rec;
    })();
    await db.transaction(async (tx) => {
      await crypto.shredDataKey(evidence.dekId, tx);
      await deletion.enqueueDeletion(tx, evidence.storageKey, org.orgId, outage.id);
      await tx
        .update(erasureRecords)
        .set({ accessRevokedAt: new Date(), keysShreddedAt: new Date(), cleanupPendingAt: new Date() })
        .where(eq(erasureRecords.id, outage.id));
    });
    await deletion.processDeletionTasks(async () => {
      throw failing;
    }, 50, { erasureId: outage.id });

    const [pending] = await db.select().from(deletionTasks).where(eq(deletionTasks.erasureId, outage.id));
    expect(pending.state).toBe("pending");
    expect(pending.attempts).toBe(1);
    expect(await objectExists(evidence.storageKey)).toBe(true);
    const [mid] = await db.select().from(erasureRecords).where(eq(erasureRecords.id, outage.id));
    expect(mid.cleanupFinishedAt).toBeNull();
    // Access is not restored while cleanup is pending.
    await expect(crypto.getDataKey(evidence.dekId)).rejects.toThrow("shredded");

    await db.update(deletionTasks).set({ availableAt: new Date(0) }).where(eq(deletionTasks.id, pending.id));
    await deletion.processDeletionTasks(realDelete, 50, { erasureId: outage.id });
    const [done] = await db.select().from(deletionTasks).where(eq(deletionTasks.id, pending.id));
    expect(done.state).toBe("done");
    expect(await objectExists(evidence.storageKey)).toBe(false);
    const [finished] = await db.select().from(erasureRecords).where(eq(erasureRecords.id, outage.id));
    expect(finished.cleanupFinishedAt).not.toBeNull();
  });
});

describe("deletion queue", () => {
  it("dead-letters after the maximum attempts and supports a safe manual retry", async () => {
    const key = `org/${randomUUID()}/${randomUUID()}`;
    await store.putRaw(key, Buffer.from("ciphertext"));
    await deletion.enqueueDeletion(db, key, "owner");
    const [task] = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, key));
    for (let i = 0; i < deletion.MAX_DELETION_ATTEMPTS; i += 1) {
      await db.update(deletionTasks).set({ availableAt: new Date(0) }).where(eq(deletionTasks.id, task.id));
      await deletion.processDeletionTasks(async (k) => {
        if (k === key) throw new Error("AccessDenied for user@example.com");
      });
    }
    const [dead] = await db.select().from(deletionTasks).where(eq(deletionTasks.id, task.id));
    expect(dead.state).toBe("dead");
    expect(dead.attempts).toBe(deletion.MAX_DELETION_ATTEMPTS);
    expect(dead.lastError ?? "").not.toContain("user@example.com");
    expect((await deletion.deletionQueueStats()).dead).toBeGreaterThanOrEqual(1);

    expect(await deletion.retryDeadDeletionTasks([task.id])).toBe(1);
    await deletion.processDeletionTasks();
    const [retried] = await db.select().from(deletionTasks).where(eq(deletionTasks.id, task.id));
    expect(retried.state).toBe("done");
    expect(await objectExists(key)).toBe(false);
    // Repeating the retry on an already-deleted object is harmless.
    await db.update(deletionTasks).set({ state: "dead" }).where(eq(deletionTasks.id, task.id));
    await deletion.retryDeadDeletionTasks([task.id]);
    await deletion.processDeletionTasks();
    expect((await db.select().from(deletionTasks).where(eq(deletionTasks.id, task.id)))[0].state).toBe("done");
  });

  it("treats a missing key as deleted but never a missing bucket", async () => {
    const gone = `org/${randomUUID()}/missing`;
    const wrongBucket = `org/${randomUUID()}/bucket`;
    await deletion.enqueueDeletion(db, gone, null);
    await deletion.enqueueDeletion(db, wrongBucket, null);
    await deletion.processDeletionTasks(async (k) => {
      if (k === gone) throw Object.assign(new Error("not found"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      if (k === wrongBucket) throw Object.assign(new Error("no bucket"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
    });
    const rows = await db.select().from(deletionTasks).where(inArray(deletionTasks.storageKey, [gone, wrongBucket]));
    expect(Object.fromEntries(rows.map((r) => [r.storageKey, r.state]))).toEqual({
      [gone]: "done",
      [wrongBucket]: "pending",
    });
    await db.delete(deletionTasks).where(eq(deletionTasks.storageKey, wrongBucket));
  });

  it("never hands one task to two concurrent workers", async () => {
    const keys = Array.from({ length: 6 }, () => `org/${randomUUID()}/${randomUUID()}`);
    for (const k of keys) await deletion.enqueueDeletion(db, k, null);
    const calls = new Map<string, number>();
    const slow = async (k: string) => {
      calls.set(k, (calls.get(k) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 30));
    };
    await Promise.all([deletion.processDeletionTasks(slow), deletion.processDeletionTasks(slow)]);
    for (const k of keys) expect(calls.get(k)).toBe(1);
  });
});

describe("reconciler", () => {
  it("queues orphaned objects past the age threshold and reports stuck and dead tasks", async () => {
    const org = await createOrgWithVault(db);
    const link = await createRequestWithLink(db, org);
    const submissionId = await createSubmission(db, link);
    const kept = await storeEvidence(org, link, submissionId);
    const orphan = `org/${org.orgId}/${randomUUID()}`;
    await store.putRaw(orphan, Buffer.from("ciphertext without a row"));
    const unrelated = `backups/${randomUUID()}`;
    await store.putRaw(unrelated, Buffer.from("not a document"));

    // Young orphans are left alone (an upload may still be committing).
    const young = await reconciler.reconcileStorage();
    expect(young.orphansQueued).toBe(0);

    const stuckKey = `org/${randomUUID()}/stuck`;
    await db.insert(deletionTasks).values({ storageKey: stuckKey, state: "pending", attempts: 3, availableAt: new Date(Date.now() + DAY) });
    await db.insert(deletionTasks).values({ storageKey: `org/${randomUUID()}/dead`, state: "dead", attempts: 8 });

    const report = await reconciler.reconcileStorage({ orphanMinAgeMs: 0 });
    expect(report.orphansQueued).toBe(1);
    expect(report.stuckTasks).toBeGreaterThanOrEqual(1);
    expect(report.deadTasks).toBeGreaterThanOrEqual(1);
    const queued = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, orphan));
    expect(queued).toHaveLength(1);

    // Re-running does not queue the same orphan twice.
    expect((await reconciler.reconcileStorage({ orphanMinAgeMs: 0 })).orphansQueued).toBe(0);

    await deletion.processDeletionTasks();
    expect(await objectExists(orphan)).toBe(false);
    expect(await objectExists(kept.storageKey)).toBe(true);
    expect(await objectExists(unrelated)).toBe(true);
  });
});

describe("account erasure", () => {
  async function seekerWithEverything() {
    const auth = authModule.auth;
    const email = `seeker-${randomUUID()}@example.test`;
    const password = `pw-${randomBytes(12).toString("hex")}`;
    const signUp = await auth.api.signUpEmail({ body: { name: "Seeker Test", email, password } });
    const userId = signUp.user.id;
    const seeker = await createCandidateWithVault(db, userId);
    const ctx = await auth.$context;
    const active = await ctx.internalAdapter.createSession(userId);
    await db.insert(passkey).values({
      id: randomUUID(),
      publicKey: "synthetic",
      userId,
      credentialID: randomUUID(),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    await db.insert(verification).values({
      id: randomUUID(),
      identifier: randomUUID(),
      value: JSON.stringify({ email }),
      expiresAt: new Date(Date.now() + DAY),
    });
    const [apiKey] = await db
      .insert(candidateApiKeys)
      .values({
        candidateAccountId: seeker.candidateAccountId,
        name: "test",
        keyHash: randomBytes(32).toString("hex"),
        prefix: "rvs_test",
        wrappedVaultKey: "synthetic-wrap",
      })
      .returning();

    const item = await crypto.encryptField("TS-PA", {
      mode: "crk",
      crk: seeker.crk,
      ownerType: "candidate",
      ownerId: seeker.candidateAccountId,
      purpose: "clearance_level",
      keyVersion: 1,
    });
    await db.insert(walletItems).values({
      candidateAccountId: seeker.candidateAccountId,
      type: "clearance_level",
      valueEncrypted: item.valueEncrypted,
      dekId: item.dekId,
    });
    const prepared = await protect.protectDocument({
      executor: db,
      bytes: samplePdf("wallet-erasure"),
      ownerType: "candidate",
      ownerId: seeker.candidateAccountId,
      purpose: "resume",
      keyVersion: 1,
      crk: seeker.crk,
      scope: "wallet",
      scan: clean,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
    await db.insert(walletDocuments).values({
      id: prepared.documentId,
      candidateAccountId: seeker.candidateAccountId,
      kind: "resume",
      fileName: "resume.pdf",
      contentType: "application/octet-stream",
      storageKey: prepared.storageKey,
      dekId: prepared.dekId,
      envelopeVersion: prepared.envelopeVersion,
      scanStatus: "clean",
    });

    const org = await createOrgWithVault(db);
    const link = await createRequestWithLink(db, org);
    const submissionId = await createSubmission(db, link, { candidateAccountId: seeker.candidateAccountId });
    const evidence = await storeEvidence(org, link, submissionId);
    await db.insert(walletShares).values({
      candidateAccountId: seeker.candidateAccountId,
      submissionId,
      walletDocumentId: prepared.documentId,
      orgId: org.orgId,
    });
    await db.insert(savedRoles).values({ candidateAccountId: seeker.candidateAccountId, requestId: link.requestId });
    const { audit } = await import("@/lib/audit");
    await audit({
      actorType: "candidate",
      actorId: seeker.candidateAccountId,
      action: "wallet_item.created",
      targetType: "wallet_item",
      ip: "203.0.113.7",
      userAgent: "synthetic-agent",
    });
    await db.insert(discoveryProfiles).values({
      candidateAccountId: seeker.candidateAccountId,
      handle: `cand_${randomBytes(5).toString("hex")}`,
    });

    return {
      ...seeker,
      email,
      password,
      sessionToken: active.token,
      apiKeyId: apiKey.id,
      itemDek: item.dekId,
      walletDoc: { storageKey: prepared.storageKey, dekId: prepared.dekId },
      evidence,
      submissionId,
    };
  }

  it("revokes access first, resumes after an interruption, and finishes cleanup", async () => {
    const s = await seekerWithEverything();
    const auth = authModule.auth;
    const ctx = await auth.$context;
    expect(await db.select().from(session).where(eq(session.userId, s.userId))).not.toHaveLength(0);

    await expect(
      retention.eraseCandidate(s.candidateAccountId, {
        afterAccessRevoked: async () => {
          throw new Error("worker killed");
        },
      }),
    ).rejects.toThrow("worker killed");

    // Step 1 committed: no way in, but keys and data not yet shredded.
    expect(await db.select().from(session).where(eq(session.userId, s.userId))).toHaveLength(0);
    expect(await db.select().from(account).where(eq(account.userId, s.userId))).toHaveLength(0);
    expect(await db.select().from(passkey).where(eq(passkey.userId, s.userId))).toHaveLength(0);
    const [key] = await db.select().from(candidateApiKeys).where(eq(candidateApiKeys.id, s.apiKeyId));
    expect(key.revokedAt).not.toBeNull();
    expect(key.wrappedVaultKey).toBeNull();
    const [tomb] = await db.select().from(user).where(eq(user.id, s.userId));
    expect(tomb.erasedAt).not.toBeNull();
    expect(tomb.email).not.toBe(s.email);
    expect(tomb.name).not.toBe("Seeker Test");
    const [interrupted] = await db
      .select()
      .from(erasureRecords)
      .where(and(eq(erasureRecords.subjectType, "candidate"), eq(erasureRecords.subjectId, s.candidateAccountId)));
    expect(interrupted.accessRevokedAt).not.toBeNull();
    expect(interrupted.keysShreddedAt).toBeNull();
    expect(await isShredded(s.itemDek)).toBe(false);

    // The old session and any new sign-in are refused.
    expect(await ctx.internalAdapter.findSession(s.sessionToken)).toBeNull();
    await expect(ctx.internalAdapter.createSession(s.userId)).rejects.toThrow(/deleted/i);
    await expect(
      auth.api.signInEmail({ body: { email: s.email, password: s.password } }),
    ).rejects.toBeTruthy();

    expect(await retention.resumeIncompleteErasures()).toBeGreaterThanOrEqual(1);

    const [record] = await db.select().from(erasureRecords).where(eq(erasureRecords.id, interrupted.id));
    expect(record.keysShreddedAt).not.toBeNull();
    expect(record.cleanupPendingAt).not.toBeNull();
    expect(record.cleanupFinishedAt).not.toBeNull();
    expect(record.objectsQueued).toBe(2);
    for (const dek of [s.itemDek, s.walletDoc.dekId, s.evidence.dekId]) expect(await isShredded(dek)).toBe(true);
    expect(await objectExists(s.walletDoc.storageKey)).toBe(false);
    expect(await objectExists(s.evidence.storageKey)).toBe(false);
    const [vault] = await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, s.candidateAccountId));
    expect(vault.privateKeyWrapped).toBeNull();
    expect(
      await db.select().from(candidateAccounts).where(eq(candidateAccounts.id, s.candidateAccountId)),
    ).toHaveLength(0);
    expect(await db.select().from(walletShares).where(eq(walletShares.candidateAccountId, s.candidateAccountId))).toHaveLength(0);
    expect(await db.select().from(discoveryProfiles).where(eq(discoveryProfiles.candidateAccountId, s.candidateAccountId))).toHaveLength(0);
    expect(await db.select().from(candidateApiKeys).where(eq(candidateApiKeys.id, s.apiKeyId))).toHaveLength(0);
    const [sub] = await db.select().from(submissions).where(eq(submissions.id, s.submissionId));
    expect(sub.purgedAt).not.toBeNull();
    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorType, "candidate"), eq(auditEvents.actorId, s.candidateAccountId)));
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((e) => e.ip === null && e.userAgent === null)).toBe(true);
    const { verifyChain } = await import("@/lib/audit");
    expect((await verifyChain(null)).ok).toBe(true);
    const leftovers = await db
      .select()
      .from(verification)
      .where(eq(verification.value, JSON.stringify({ email: s.email })));
    expect(leftovers).toHaveLength(0);

    // Idempotent: a repeat neither fails nor queues more work, and the tombstone
    // still cannot get a session.
    const again = await retention.eraseCandidate(s.candidateAccountId);
    expect(again?.erasureId).toBe(record.id);
    expect(await db.select().from(deletionTasks).where(eq(deletionTasks.erasureId, record.id))).toHaveLength(2);
    await expect(ctx.internalAdapter.createSession(s.userId)).rejects.toThrow(/deleted/i);
  });

  it("deletes a wallet document by shredding its key and queueing its object", async () => {
    const seeker = await createCandidateWithVault(db);
    const prepared = await protect.protectDocument({
      executor: db,
      bytes: samplePdf("wallet-delete"),
      ownerType: "candidate",
      ownerId: seeker.candidateAccountId,
      purpose: "resume",
      keyVersion: 1,
      crk: seeker.crk,
      scope: "wallet",
      scan: clean,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
    await db.insert(walletDocuments).values({
      id: prepared.documentId,
      candidateAccountId: seeker.candidateAccountId,
      kind: "resume",
      fileName: "resume.pdf",
      contentType: "application/octet-stream",
      storageKey: prepared.storageKey,
      dekId: prepared.dekId,
      envelopeVersion: prepared.envelopeVersion,
      scanStatus: "clean",
    });
    const other = await createCandidateWithVault(db);
    expect(await retention.deleteWalletDocumentRecord(other.candidateAccountId, prepared.documentId)).toBe(false);
    expect(await retention.deleteWalletDocumentRecord(seeker.candidateAccountId, prepared.documentId)).toBe(true);
    expect(await isShredded(prepared.dekId)).toBe(true);
    const [task] = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, prepared.storageKey));
    expect(task.state).toBe("pending");
    await deletion.processDeletionTasks();
    expect(await objectExists(prepared.storageKey)).toBe(false);
  });
});

describe("retention policy branches", () => {
  it("selects exactly the due submissions and abandoned drafts", async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const ahead = (days: number) => new Date(now.getTime() + days * DAY);
    const expected = new Set<string>();
    const notExpected = new Set<string>();

    // Default policy: 30 days after submission.
    const def = await createOrgWithVault(db, { retentionDays: 30 });
    const defLink = await createRequestWithLink(db, def);
    expected.add(await createSubmission(db, defLink, { submittedAt: ago(31) }));
    notExpected.add(await createSubmission(db, (await createRequestWithLink(db, def)), { submittedAt: ago(5) }));

    // Purge on close: 10 days after the role closed or expired; open roles capped.
    const poc = await createOrgWithVault(db, { retentionDays: 10, purgeOnClose: true });
    const closedLong = await createRequestWithLink(db, poc, { status: "closed", closedAt: ago(11) });
    expected.add(await createSubmission(db, closedLong, { submittedAt: ago(40) }));
    const closedRecent = await createRequestWithLink(db, poc, { status: "closed", closedAt: ago(2) });
    notExpected.add(await createSubmission(db, closedRecent, { submittedAt: ago(40) }));
    const expired = await createRequestWithLink(db, poc, { expiresAt: ago(11) });
    expected.add(await createSubmission(db, expired, { submittedAt: ago(20) }));
    const openFresh = await createRequestWithLink(db, poc);
    notExpected.add(await createSubmission(db, openFresh, { submittedAt: ago(200) }));
    const openAncient = await createRequestWithLink(db, poc);
    expected.add(
      await createSubmission(db, openAncient, {
        submittedAt: ago(10 + retention.OPEN_ROLE_BACKSTOP_DAYS + 1),
      }),
    );

    // Abandoned drafts, under a long default policy so only the draft rule applies.
    const drafts = await createOrgWithVault(db, { retentionDays: 3650 });
    const expiredLink = await createRequestWithLink(db, drafts, { linkExpiresAt: ago(1) });
    const expiredDraft = await createSubmission(db, expiredLink, { status: "started" });
    expected.add(expiredDraft);
    const draftValue = await crypto.encryptField("draft answer", {
      mode: "link",
      linkSecret: "synthetic-link-secret",
      purpose: "draft",
    });
    await db.insert(submissionValues).values({
      submissionId: expiredDraft,
      fieldId: expiredLink.textFieldId,
      valueEncrypted: draftValue.valueEncrypted,
      dekId: draftValue.dekId,
    });
    const revokedLink = await createRequestWithLink(db, drafts, { linkRevokedAt: ago(1), linkExpiresAt: ahead(5) });
    expected.add(await createSubmission(db, revokedLink, { status: "started" }));
    const closedRole = await createRequestWithLink(db, drafts, { status: "closed", closedAt: ago(1) });
    expected.add(await createSubmission(db, closedRole, { status: "started" }));
    const liveLink = await createRequestWithLink(db, drafts);
    notExpected.add(await createSubmission(db, liveLink, { status: "started" }));

    // Already purged rows are never selected again.
    const purgedLink = await createRequestWithLink(db, def);
    const purgedId = await createSubmission(db, purgedLink, { submittedAt: ago(100) });
    await db.update(submissions).set({ purgedAt: ago(1) }).where(eq(submissions.id, purgedId));
    notExpected.add(purgedId);

    const due = new Set(await retention.findPurgeDueSubmissionIds(now));
    for (const id of expected) expect(due.has(id), `expected ${id}`).toBe(true);
    for (const id of notExpected) expect(due.has(id), `unexpected ${id}`).toBe(false);

    // Purging an abandoned draft shreds its link-wrapped values.
    await retention.purgeSubmission(expiredDraft, { actorType: "system" });
    expect((await db.select().from(submissions).where(eq(submissions.id, expiredDraft)))[0].purgedAt).not.toBeNull();
    expect(await isShredded(draftValue.dekId)).toBe(true);
    expect(await db.select().from(submissionValues).where(eq(submissionValues.submissionId, expiredDraft))).toHaveLength(0);
  });
});
