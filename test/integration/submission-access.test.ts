import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { documents, memberships, requests, submissionDocuments, submissionShares, submissionValues, user } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { startObjectStore, type TestObjectStore } from "./object-store";
import { createOrgWithVault, createRequestWithLink, createSubmission, samplePdf } from "./fixtures";
import { asBrowser, authRequest, newBrowser, signUpVerified, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * Recruiters reach only their own requests' submissions (or ones shared with
 * them), sharing cannot widen that, and drafts are never treated as
 * applications. Documents follow the same rule as submissions.
 */

type Role = "owner" | "recruiter" | "reviewer";
type Member = { browser: Browser; userId: string; email: string };

let stopDb: () => Promise<void>;
let store: TestObjectStore;
let db: typeof import("@/db").db;
let requestActions: typeof import("@/actions/requests");
let viewRoute: typeof import("@/app/api/documents/[id]/view/route");
let exportRoute: typeof import("@/app/api/requests/[id]/export/route");

let org: Awaited<ReturnType<typeof createOrgWithVault>>;
let owner: Member;
let recruiterA: Member;
let recruiterB: Member;
let reviewer: Member;
let lockedOwner: Browser;
let requestA: Awaited<ReturnType<typeof createRequestWithLink>>;
let submissionId: string;
let draftId: string;
let evidenceId: string;
let jdId: string;

const PASSWORD = "correct-horse-battery";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

async function member(email: string, role: Role): Promise<Member> {
  const browser = newBrowser();
  await signUpVerified(browser, email);
  const [row] = await db.select().from(user).where(eq(user.email, email));
  await db.update(user).set({ accountType: "org" }).where(eq(user.id, row.id));
  await db.insert(memberships).values({ orgId: org.orgId, userId: row.id, role });
  const { unlockVault } = await import("@/actions/vault");
  const unlocked = await asBrowser(browser, () => unlockVault(form({ encryptionKey: org.crk.toString("base64url") })));
  expect(unlocked.ok).toBe(true);
  return { browser, userId: row.id, email };
}

async function storeDocument(kind: "jd" | "evidence", marker: string) {
  const protect = await import("@/lib/document-protect");
  const bytes = samplePdf(marker);
  const prepared = await protect.protectDocument({
    executor: db,
    bytes,
    ownerType: "organisation",
    ownerId: org.orgId,
    purpose: kind,
    keyVersion: org.vault!.version,
    recipientPublicKey: org.vault!.publicKey,
    scope: "org",
    scan: async () => "clean",
  });
  if (!prepared.ok) throw new Error(prepared.error);
  await protect.putProtectedObject(prepared.storageKey, prepared.ciphertext);
  await db.insert(documents).values({
    id: prepared.documentId,
    orgId: org.orgId,
    kind,
    fileName: `${kind}.pdf`,
    contentType: "application/octet-stream",
    originalContentType: "application/pdf",
    sizeBytes: bytes.length,
    storageKey: prepared.storageKey,
    dekId: prepared.dekId,
    envelopeVersion: prepared.envelopeVersion,
    scanStatus: "clean",
    watermarkRequired: false,
  });
  return prepared.documentId;
}

function viewDocument(browser: Browser, id: string) {
  return asBrowser(browser, () =>
    viewRoute.GET(new NextRequest(`http://localhost:3000/api/documents/${id}/view`), params(id)),
  );
}

function exportRequest(browser: Browser, id: string) {
  return asBrowser(browser, () =>
    exportRoute.GET(new NextRequest(`http://localhost:3000/api/requests/${id}/export?format=json`), params(id)),
  );
}

async function shares() {
  return db.select().from(submissionShares).where(eq(submissionShares.submissionId, submissionId));
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "66".repeat(32);
  store = await startObjectStore();
  ({ db, stop: stopDb } = await setupMigratedDatabase());
  requestActions = await import("@/actions/requests");
  viewRoute = await import("@/app/api/documents/[id]/view/route");
  exportRoute = await import("@/app/api/requests/[id]/export/route");

  org = await createOrgWithVault(db);
  owner = await member("access-owner@example.invalid", "owner");
  recruiterA = await member("recruiter-a@example.invalid", "recruiter");
  recruiterB = await member("recruiter-b@example.invalid", "recruiter");
  reviewer = await member("reviewer@example.invalid", "reviewer");
  lockedOwner = newBrowser();
  const signIn = await authRequest(lockedOwner, "/sign-in/email", {
    body: { email: owner.email, password: PASSWORD },
  });
  expect(signIn.status).toBe(200);

  requestA = await createRequestWithLink(db, { orgId: org.orgId, ownerUserId: recruiterA.userId });
  submissionId = await createSubmission(db, requestA);
  draftId = await createSubmission(db, requestA, { status: "started" });

  // A submitted answer sealed to the organisation, and a draft answer wrapped
  // for the responder's link only.
  const crypto = await import("@/lib/crypto");
  const sealed = await crypto.encryptField("submitted-answer-4410", {
    mode: "sealed",
    recipientPublicKey: org.vault!.publicKey,
    ownerType: "organisation",
    ownerId: org.orgId,
    purpose: "submission",
    keyVersion: org.vault!.version,
  });
  const draft = await crypto.encryptField("draft-answer-9921", {
    mode: "link",
    linkSecret: "synthetic-draft-secret",
    purpose: "draft",
    linkId: requestA.accessTokenId,
  });
  await db.insert(submissionValues).values([
    { submissionId, fieldId: requestA.textFieldId, ...sealed },
    { submissionId: draftId, fieldId: requestA.textFieldId, ...draft },
  ]);

  evidenceId = await storeDocument("evidence", "evidence-marker");
  await db.insert(submissionDocuments).values({ submissionId, fieldId: requestA.fieldId, documentId: evidenceId });
  jdId = await storeDocument("jd", "jd-marker");
  await db.update(requests).set({ jdDocumentId: jdId }).where(eq(requests.id, requestA.requestId));
});

afterAll(async () => {
  await stopDb?.();
  await store?.stop();
});

describe("organisation document access", () => {
  it("keeps another recruiter's request documents out of reach", async () => {
    expect((await viewDocument(recruiterB.browser, evidenceId)).status).toBe(403);
    expect((await viewDocument(recruiterB.browser, jdId)).status).toBe(403);
    expect((await viewDocument(reviewer.browser, evidenceId)).status).toBe(403);
  });

  it("lets the request's recruiter and view-all roles open them", async () => {
    for (const browser of [recruiterA.browser, owner.browser]) {
      const evidence = await viewDocument(browser, evidenceId);
      expect(evidence.status).toBe(200);
      expect(Buffer.from(await evidence.arrayBuffer()).toString("latin1")).toContain("evidence-marker");
      expect((await viewDocument(browser, jdId)).status).toBe(200);
    }
  });
});

describe("shareSubmission", () => {
  it("refuses a recruiter who cannot review the submission", async () => {
    const result = await asBrowser(recruiterB.browser, () =>
      requestActions.shareSubmission(form({ submissionId, userId: recruiterB.userId })),
    );
    expect(result.ok).toBe(false);
    const toReviewer = await asBrowser(recruiterB.browser, () =>
      requestActions.shareSubmission(form({ submissionId, userId: reviewer.userId })),
    );
    expect(toReviewer.ok).toBe(false);
    expect(await shares()).toHaveLength(0);
    // Self-sharing never created access for the other recruiter.
    expect((await viewDocument(recruiterB.browser, evidenceId)).status).toBe(403);
  });

  it("refuses self-shares, non-reviewer targets, and drafts", async () => {
    const self = await asBrowser(recruiterA.browser, () =>
      requestActions.shareSubmission(form({ submissionId, userId: recruiterA.userId })),
    );
    expect(self).toMatchObject({ ok: false, error: expect.stringMatching(/other than yourself/) });
    const toRecruiter = await asBrowser(recruiterA.browser, () =>
      requestActions.shareSubmission(form({ submissionId, userId: recruiterB.userId })),
    );
    expect(toRecruiter).toMatchObject({ ok: false, error: expect.stringMatching(/only be shared with reviewers/) });
    const draft = await asBrowser(recruiterA.browser, () =>
      requestActions.shareSubmission(form({ submissionId: draftId, userId: reviewer.userId })),
    );
    expect(draft.ok).toBe(false);
    expect(await shares()).toHaveLength(0);
  });

  it("shares with a reviewer, who can then open the submission's documents only", async () => {
    const shared = await asBrowser(recruiterA.browser, () =>
      requestActions.shareSubmission(form({ submissionId, userId: reviewer.userId })),
    );
    expect(shared.ok).toBe(true);
    expect(await shares()).toHaveLength(1);
    expect((await viewDocument(reviewer.browser, evidenceId)).status).toBe(200);
    expect((await viewDocument(reviewer.browser, jdId)).status).toBe(403);

    const { requireOrgUser } = await import("@/lib/guards");
    const { loadSubmissionForReview } = await import("@/lib/review");
    const review = await asBrowser(reviewer.browser, async () =>
      loadSubmissionForReview(await requireOrgUser(), submissionId),
    );
    expect(review.values.find((value) => value.fieldId === requestA.textFieldId)?.value).toBe("submitted-answer-4410");
  });
});

describe("drafts are not applications", () => {
  it("cannot be opened for review or re-statused", async () => {
    const { requireOrgUser } = await import("@/lib/guards");
    const { loadSubmissionForReview } = await import("@/lib/review");
    await expect(
      asBrowser(owner.browser, async () => loadSubmissionForReview(await requireOrgUser(), draftId)),
    ).rejects.toThrow(/still in progress/);
    const { setSubmissionStatus } = await import("@/actions/submissions");
    const status = await asBrowser(owner.browser, () =>
      setSubmissionStatus(form({ submissionId: draftId, status: "shortlisted" })),
    );
    expect(status.ok).toBe(false);
  });

  it("are left out of exports, which need an unlocked vault", async () => {
    expect((await exportRequest(recruiterB.browser, requestA.requestId)).status).toBe(403);
    const locked = await exportRequest(lockedOwner, requestA.requestId);
    expect(locked.status).toBe(409);

    for (const browser of [owner.browser, recruiterA.browser]) {
      const exported = await exportRequest(browser, requestA.requestId);
      expect(exported.status).toBe(200);
      const rows = (await exported.json()) as Record<string, string>[];
      expect(rows.map((row) => row.submission_id)).toEqual([submissionId]);
      expect(rows[0].Note).toBe("submitted-answer-4410");
    }
  });
});

describe("setRequestStatus", () => {
  it("clears the close time when a role is reopened", async () => {
    const close = await asBrowser(recruiterA.browser, () =>
      requestActions.setRequestStatus(form({ requestId: requestA.requestId, status: "closed" })),
    );
    expect(close.ok).toBe(true);
    const [closed] = await db.select().from(requests).where(eq(requests.id, requestA.requestId));
    expect(closed.closedAt).not.toBeNull();

    for (const status of ["open", "closing_soon"]) {
      await asBrowser(recruiterA.browser, () =>
        requestActions.setRequestStatus(form({ requestId: requestA.requestId, status: "closed" })),
      );
      const reopen = await asBrowser(recruiterA.browser, () =>
        requestActions.setRequestStatus(form({ requestId: requestA.requestId, status })),
      );
      expect(reopen.ok).toBe(true);
      const [row] = await db
        .select()
        .from(requests)
        .where(and(eq(requests.id, requestA.requestId), eq(requests.status, status as "open" | "closing_soon")));
      expect(row.closedAt).toBeNull();
    }
  });
});
