import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accessTokens, backupConfig, submissions, submissionValues } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { createOrgWithVault, createRequestWithLink } from "./fixtures";
import { asBrowser, newBrowser, signUpVerified, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * Regressions found by the security matrix (#35). Every export of a
 * "use server" module is reachable by direct POST, so each one must check the
 * caller itself, including helpers that only a Server Component calls.
 */

const TOKEN = "bt-" + "5d".repeat(24);
const PLATFORM_KEY = randomBytes(32).toString("base64url");
const TENANT_KEY = randomBytes(32).toString("base64url");
const PLATFORM_GATE = /platform organisation/;

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let platformOwner: Browser;
let tenantOwner: Browser;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

function keyFields(key: string) {
  return { keyMode: "import", encryptionKey: key, encryptionKeyConfirm: key, keyBackupAck: "yes" };
}

function backupForm() {
  return form({
    enabled: "on",
    hourUtc: "3",
    retainCount: "7",
    r2AccountId: "0123456789abcdef0123456789abcdef",
    r2Bucket: "tenant-controlled-bucket",
    r2AccessKeyId: "synthetic-access-key-id",
    r2SecretAccessKey: "synthetic-secret-value",
  });
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "6e".repeat(32);
  process.env.BOOTSTRAP_TOKEN = TOKEN;
  process.env.ALLOW_RECRUITER_SIGNUP = "true";
  ({ db, stop } = await setupMigratedDatabase());

  platformOwner = newBrowser();
  await signUpVerified(platformOwner, "platform-owner@example.invalid");
  const { completePlatformSetup } = await import("@/actions/setup");
  const setup = await asBrowser(platformOwner, () =>
    completePlatformSetup(form({ organisationName: "Platform Org", bootstrapToken: TOKEN, ...keyFields(PLATFORM_KEY) })),
  );
  expect(setup.ok).toBe(true);

  // A second tenant created through ordinary recruiter sign-up.
  tenantOwner = newBrowser();
  await signUpVerified(tenantOwner, "tenant-owner@example.invalid", { accountType: "org" });
  const { createOrganisation } = await import("@/actions/org");
  const created = await asBrowser(tenantOwner, () =>
    createOrganisation(form({ name: "Second Tenant", ...keyFields(TENANT_KEY) })),
  );
  expect(created.ok).toBe(true);
});

afterAll(async () => {
  delete process.env.ALLOW_RECRUITER_SIGNUP;
  await stop?.();
});

describe("platform-wide backups", () => {
  it("refuse another organisation's owner, who must not pick the destination or receive the key", async () => {
    const backup = await import("@/actions/backup");
    const saved = await asBrowser(tenantOwner, () => backup.updateBackupSettings(backupForm()));
    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(PLATFORM_GATE);
    expect(saved.backupKey).toBeUndefined();
    expect(await db.select().from(backupConfig)).toHaveLength(0);

    const run = await asBrowser(tenantOwner, () => backup.runBackupNow());
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(PLATFORM_GATE);
  });

  it("still admit the platform organisation's owner past the tenant check", async () => {
    const backup = await import("@/actions/backup");
    // The synthetic R2 account is unreachable, so the save stops at the
    // credential check; the point is that it gets past the tenant gate.
    const saved = await asBrowser(platformOwner, () => backup.updateBackupSettings(backupForm()));
    expect(saved.error ?? "").not.toMatch(PLATFORM_GATE);
    const run = await asBrowser(platformOwner, () => backup.runBackupNow());
    expect(run.error ?? "").not.toMatch(PLATFORM_GATE);
  });
});

describe("loadDraftValues", () => {
  it("returns a draft only to that link's verified session, even for legacy LOCAL_KEK drafts", async () => {
    const org = await createOrgWithVault(db);
    const target = await createRequestWithLink(db, org);
    const other = await createRequestWithLink(db, org);
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, target.accessTokenId));
    await db.update(accessTokens).set({ verifiedAt: new Date() }).where(eq(accessTokens.id, other.accessTokenId));

    // A draft written before customer vaults: its key unwraps with LOCAL_KEK alone.
    const { encryptField } = await import("@/lib/crypto");
    const marker = `legacy-draft-${randomBytes(6).toString("hex")}`;
    const [draft] = await db
      .insert(submissions)
      .values({ requestId: target.requestId, accessTokenId: target.accessTokenId, status: "started" })
      .returning();
    const sealed = await encryptField(marker, { mode: "legacy" });
    await db.insert(submissionValues).values({ submissionId: draft.id, fieldId: target.textFieldId, ...sealed });

    const { issueLinkSession } = await import("@/lib/link-session");
    const { loadDraftValues } = await import("@/actions/link");
    const anonymous = newBrowser();
    const otherResponder = newBrowser();
    await asBrowser(otherResponder, () => issueLinkSession(other.accessTokenId));
    const owner = newBrowser();
    await asBrowser(owner, () => issueLinkSession(target.accessTokenId));

    for (const [label, browser] of [["anonymous", anonymous], ["another link's session", otherResponder]] as const) {
      const values = await asBrowser(browser, () => loadDraftValues(target.accessTokenId));
      expect(JSON.stringify(values), label).not.toContain(marker);
      expect(values, label).toEqual({});
    }
    const own = await asBrowser(owner, () => loadDraftValues(target.accessTokenId));
    expect(own[target.textFieldId]).toBe(marker);
  });
});
