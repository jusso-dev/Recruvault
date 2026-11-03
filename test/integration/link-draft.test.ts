import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { accessTokens, consents, dataKeys, requestFields, requests, submissions, submissionValues, vaultKeys } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { createOrgWithVault, createRequestWithLink } from "./fixtures";
import { asBrowser, newBrowser, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * Secure-link drafts: accepted only for a verified, live link whose
 * organisation has an active vault, and stored as ciphertext bound to the link.
 */

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let link: typeof import("@/actions/link");

async function responder(accessTokenId: string): Promise<Browser> {
  const browser = newBrowser();
  const { ensureDraftSecret, issueLinkSession } = await import("@/lib/link-session");
  await asBrowser(browser, async () => {
    await issueLinkSession(accessTokenId);
    await ensureDraftSecret(accessTokenId, new Date(Date.now() + 86_400_000));
  });
  return browser;
}

/** Give the link a known raw token and pass the real OTP step-up as this browser. */
async function verifyThroughOtp(browser: Browser, accessTokenId: string, rawToken: string) {
  const { sha256 } = await import("@/lib/crypto");
  await db
    .update(accessTokens)
    .set({
      tokenHash: sha256(rawToken),
      otpHash: sha256("246810"),
      otpExpiresAt: new Date(Date.now() + 600_000),
      otpAttempts: 0,
    })
    .where(eq(accessTokens.id, accessTokenId));
  const result = await asBrowser(browser, () => link.verifyOtp(rawToken, "246810"));
  expect(result.ok).toBe(true);
}

async function draftKeyIds(accessTokenId: string) {
  const rows = await db
    .selectDistinct({ dekId: submissionValues.dekId })
    .from(submissionValues)
    .innerJoin(submissions, eq(submissions.id, submissionValues.submissionId))
    .where(and(eq(submissions.accessTokenId, accessTokenId), eq(submissions.status, "started")));
  return rows.map((row) => row.dekId);
}

async function isShredded(dekId: string) {
  const [row] = await db.select().from(dataKeys).where(eq(dataKeys.id, dekId));
  return row.shreddedAt !== null && row.wrappedKey === null;
}

function draft(fieldId: string, value: string) {
  const data = new FormData();
  data.set(`field_${fieldId}`, value);
  return data;
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "55".repeat(32);
  ({ db, stop } = await setupMigratedDatabase());
  link = await import("@/actions/link");
});

afterAll(async () => {
  await stop?.();
});

describe("saveDraft", () => {
  it("stores an encrypted draft for an enrolled organisation", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);

    const result = await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "draft-marker-7731")));
    expect(result.ok).toBe(true);
    const [sub] = await db.select().from(submissions).where(eq(submissions.accessTokenId, l.accessTokenId));
    expect(sub.status).toBe("started");
    const values = await db.select().from(submissionValues).where(eq(submissionValues.submissionId, sub.id));
    expect(values).toHaveLength(1);
    expect(values[0].valueEncrypted).not.toContain("draft-marker-7731");
  });

  it("refuses a draft when the organisation has no active vault", async () => {
    const org = await createOrgWithVault(db, { vault: false });
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);

    const result = await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "no-vault")));
    expect(result.ok).toBe(false);
    expect(await db.select().from(submissions).where(eq(submissions.accessTokenId, l.accessTokenId))).toHaveLength(0);
  });

  it("refuses a draft once the organisation's vault is retired", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    await db.update(vaultKeys).set({ status: "retired" }).where(eq(vaultKeys.id, org.vault!.id));
    const browser = await responder(l.accessTokenId);

    const result = await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "retired")));
    expect(result.ok).toBe(false);
  });

  it("refuses unverified, revoked, and missing link sessions", async () => {
    const org = await createOrgWithVault(db);
    const unverified = await createRequestWithLink(db, org);
    const revoked = await createRequestWithLink(db, org, { linkRevokedAt: new Date() });
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, revoked.accessTokenId));

    for (const l of [unverified, revoked]) {
      const browser = await responder(l.accessTokenId);
      const result = await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "x")));
      expect(result.ok).toBe(false);
    }
    const anonymous = await asBrowser(newBrowser(), () => link.saveDraft(draft(unverified.textFieldId, "x")));
    expect(anonymous.ok).toBe(false);
  });
});

describe("draft restore", () => {
  it("restores a draft after the link session expires and the responder re-verifies", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    const rawToken = randomBytes(32).toString("base64url");
    const browser = newBrowser();
    await verifyThroughOtp(browser, l.accessTokenId, rawToken);
    expect(browser.jar.get(`rv_link_draft_${l.accessTokenId}`)).toBeTruthy();

    const saved = await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "draft-restore-5150")));
    expect(saved.ok).toBe(true);
    const secret = browser.jar.get(`rv_link_draft_${l.accessTokenId}`);

    // The one-hour session lapses; the draft cannot be read until re-verification.
    browser.jar.delete("rv_link_session");
    expect(await asBrowser(browser, () => link.loadDraftValues(l.accessTokenId))).toEqual({
      values: {},
      restoreFailed: false,
    });
    expect(await draftKeyIds(l.accessTokenId)).toHaveLength(1);

    await verifyThroughOtp(browser, l.accessTokenId, rawToken);
    expect(browser.jar.get(`rv_link_draft_${l.accessTokenId}`)).toBe(secret);
    const restored = await asBrowser(browser, () => link.loadDraftValues(l.accessTokenId));
    expect(restored).toEqual({ values: { [l.textFieldId]: "draft-restore-5150" }, restoreFailed: false });
  });

  it("discards a draft this browser cannot open and says so instead of failing", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);
    expect((await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "lost-draft")))).ok).toBe(true);
    const [dekId] = await draftKeyIds(l.accessTokenId);

    browser.jar.set(`rv_link_draft_${l.accessTokenId}`, randomBytes(32).toString("base64url"));
    const result = await asBrowser(browser, () => link.loadDraftValues(l.accessTokenId));
    expect(result).toEqual({ values: {}, restoreFailed: true });
    expect(await isShredded(dekId)).toBe(true);
    expect(await draftKeyIds(l.accessTokenId)).toHaveLength(0);

    // Another link's session cannot read, or discard, this link's draft.
    const other = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, other.accessTokenId));
    const stranger = await responder(other.accessTokenId);
    expect(await asBrowser(stranger, () => link.loadDraftValues(l.accessTokenId))).toEqual({
      values: {},
      restoreFailed: false,
    });
  });

  it("keeps a draft that another browser holds the secret for", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const first = await responder(l.accessTokenId);
    expect((await asBrowser(first, () => link.saveDraft(draft(l.textFieldId, "first-device")))).ok).toBe(true);
    const [dekId] = await draftKeyIds(l.accessTokenId);

    // Same verified link on a second device: no draft secret there.
    const second = newBrowser();
    const { issueLinkSession } = await import("@/lib/link-session");
    await asBrowser(second, () => issueLinkSession(l.accessTokenId));
    expect(await asBrowser(second, () => link.loadDraftValues(l.accessTokenId))).toEqual({
      values: {},
      restoreFailed: true,
    });
    expect(await isShredded(dekId)).toBe(false);
    expect(await asBrowser(first, () => link.loadDraftValues(l.accessTokenId))).toEqual({
      values: { [l.textFieldId]: "first-device" },
      restoreFailed: false,
    });
  });

  it("creates no key for an empty draft and shreds the old key when a draft is replaced", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);

    expect((await asBrowser(browser, () => link.saveDraft(new FormData()))).ok).toBe(true);
    const linkKeys = () =>
      db.select().from(dataKeys).where(and(eq(dataKeys.ownerId, l.accessTokenId), eq(dataKeys.purpose, "draft")));
    expect(await linkKeys()).toHaveLength(0);

    await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "first")));
    const [first] = await draftKeyIds(l.accessTokenId);
    await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "second")));
    expect(await isShredded(first)).toBe(true);
    expect(await draftKeyIds(l.accessTokenId)).toHaveLength(1);
  });

  it("shreds the draft key when the response is finally submitted", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(requestFields).set({ required: false }).where(eq(requestFields.id, l.fieldId));
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);
    await asBrowser(browser, () => link.saveDraft(draft(l.textFieldId, "draft-before-submit")));
    const [dekId] = await draftKeyIds(l.accessTokenId);

    const final = draft(l.textFieldId, "final answer");
    final.set("consent", "on");
    const submitted = await asBrowser(browser, () => link.submitResponse(final));
    expect(submitted.ok).toBe(true);
    expect(await isShredded(dekId)).toBe(true);
    const rows = await db.select().from(submissions).where(eq(submissions.accessTokenId, l.accessTokenId));
    expect(rows.map((row) => row.status)).toEqual(["received"]);
  });

  it("requires and records NDA acceptance when the role has an NDA", async () => {
    const org = await createOrgWithVault(db);
    const l = await createRequestWithLink(db, org);
    await db.update(requestFields).set({ required: false }).where(eq(requestFields.id, l.fieldId));
    const ndaDocumentId = crypto.randomUUID();
    await db.update(requests).set({ ndaDocumentId }).where(eq(requests.id, l.requestId));
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, l.accessTokenId));
    const browser = await responder(l.accessTokenId);

    const withoutNda = draft(l.textFieldId, "answer");
    withoutNda.set("consent", "on");
    const refused = await asBrowser(browser, () => link.submitResponse(withoutNda));
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/accept the NDA/) });

    // Accepting an NDA other than the role's current one is refused.
    const stale = draft(l.textFieldId, "answer");
    stale.set("consent", "on");
    stale.set("nda", "on");
    stale.set("ndaDocumentId", crypto.randomUUID());
    expect(await asBrowser(browser, () => link.submitResponse(stale))).toEqual({
      ok: false,
      error: expect.stringMatching(/NDA for this role has changed/),
    });

    const accepted = draft(l.textFieldId, "answer");
    accepted.set("consent", "on");
    accepted.set("nda", "on");
    accepted.set("ndaDocumentId", ndaDocumentId);
    expect((await asBrowser(browser, () => link.submitResponse(accepted))).ok).toBe(true);
    const [submission] = await db.select().from(submissions).where(eq(submissions.accessTokenId, l.accessTokenId));
    const recorded = await db.select().from(consents).where(eq(consents.submissionId, submission.id));
    expect(recorded.map((row) => row.type).sort()).toEqual(["collection", "nda"]);
  });
});
