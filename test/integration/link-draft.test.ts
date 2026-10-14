import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accessTokens, submissions, submissionValues, vaultKeys } from "@/db/schema";
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
  const { issueLinkSession } = await import("@/lib/link-session");
  await asBrowser(browser, () => issueLinkSession(accessTokenId));
  return browser;
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
