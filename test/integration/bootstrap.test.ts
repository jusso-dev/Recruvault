import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { memberships, organisations, platformBootstrap, user, vaultKeys } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { asBrowser, authRequest, newBrowser, signUpVerified, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const TOKEN = "bt-" + "7f".repeat(24);
const KEY = "kM3h9QzX2vB7nR4tY8wE1aS6dF0gH5jL3pO9iU2yT7c";

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let setup: typeof import("@/actions/setup");
let org: typeof import("@/actions/org");
let bootstrap: typeof import("@/lib/platform-bootstrap");

function setupForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  const values = {
    firstName: "First",
    lastName: "Owner",
    organisationName: "Acacia Talent",
    bootstrapToken: TOKEN,
    keyMode: "import",
    encryptionKey: KEY,
    encryptionKeyConfirm: KEY,
    keyBackupAck: "yes",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

async function accountType(email: string) {
  const [row] = await db.select({ accountType: user.accountType }).from(user).where(eq(user.email, email));
  return row?.accountType;
}

async function verifiedBrowser(email: string): Promise<Browser> {
  const browser = newBrowser();
  const response = await signUpVerified(browser, email);
  expect(response.status).toBeLessThan(400);
  return browser;
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "22".repeat(32);
  process.env.BOOTSTRAP_TOKEN = TOKEN;
  delete process.env.BOOTSTRAP_RECOVERY_TOKEN;
  delete process.env.ALLOW_RECRUITER_SIGNUP;
  ({ db, stop } = await setupMigratedDatabase());
  setup = await import("@/actions/setup");
  org = await import("@/actions/org");
  bootstrap = await import("@/lib/platform-bootstrap");
});

afterAll(async () => {
  await stop?.();
});

beforeEach(() => {
  bootstrap.resetBootstrapCache();
});

describe("first-owner bootstrap", () => {
  it("never lets a client choose its account type", async () => {
    const browser = newBrowser();
    const blocked = await authRequest(browser, "/sign-up/email", {
      body: { name: "Org Claim", email: "claim@example.invalid", password: "correct-horse-battery", accountType: "org" },
    });
    expect(blocked.status).toBe(403);

    await verifiedBrowser("seeker@example.invalid");
    const seeker = newBrowser();
    await authRequest(seeker, "/sign-in/email", {
      body: { email: "seeker@example.invalid", password: "correct-horse-battery" },
    });
    const update = await authRequest(seeker, "/update-user", { body: { accountType: "org" } });
    expect(update.status).toBe(400);
    expect(await accountType("seeker@example.invalid")).toBe("seeker");
  });

  it("keeps ordinary organisation creation closed before bootstrap", async () => {
    process.env.ALLOW_RECRUITER_SIGNUP = "true";
    try {
      const browser = newBrowser();
      await signUpVerified(browser, "early-recruiter@example.invalid", { accountType: "org" });
      expect(await accountType("early-recruiter@example.invalid")).toBe("org");
      const form = setupForm();
      form.set("name", "Shadow Org");
      const result = await asBrowser(browser, () => org.createOrganisation(form));
      expect(result.ok).toBe(false);
      expect(await db.select().from(memberships)).toHaveLength(0);
      expect(await bootstrap.isPlatformBootstrapped()).toBe(false);
    } finally {
      delete process.env.ALLOW_RECRUITER_SIGNUP;
    }
  });

  it("rejects unverified accounts, missing and wrong tokens", async () => {
    const unverified = newBrowser();
    await signUpVerified(unverified, "unverified@example.invalid", { verify: false });
    const pending = await asBrowser(unverified, () => setup.completePlatformSetup(setupForm()));
    expect(pending).toMatchObject({ ok: false, error: expect.stringMatching(/verify/i) });
    const [row] = await db.select().from(user).where(eq(user.email, "unverified@example.invalid"));
    expect(row.emailVerified).toBe(false);

    const verified = await verifiedBrowser("wrong-token@example.invalid");
    const missing = await asBrowser(verified, () => setup.completePlatformSetup(setupForm({ bootstrapToken: "" })));
    expect(missing.ok).toBe(false);
    const wrong = await asBrowser(verified, () =>
      setup.completePlatformSetup(setupForm({ bootstrapToken: TOKEN.replace(/f$/, "e") })),
    );
    expect(wrong).toMatchObject({ ok: false, error: "The bootstrap token is not valid." });
    expect(JSON.stringify(wrong)).not.toContain(TOKEN);
    expect(await db.select().from(organisations)).toHaveLength(0);
    expect(await db.select().from(platformBootstrap)).toHaveLength(0);
  });

  it("lets exactly one of several concurrent valid claims win, with recruiter signup closed", async () => {
    expect(process.env.ALLOW_RECRUITER_SIGNUP).toBeUndefined();
    const browsers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => verifiedBrowser(`owner-${n}@example.invalid`)),
    );
    const results = await Promise.all(
      browsers.map((browser) => asBrowser(browser, () => setup.completePlatformSetup(setupForm()))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await db.select().from(organisations)).toHaveLength(1);
    const owners = await db.select().from(memberships).where(eq(memberships.role, "owner"));
    expect(owners).toHaveLength(1);
    const consumed = await db.select().from(platformBootstrap);
    expect(consumed).toHaveLength(1);
    expect(consumed[0].consumedAt).not.toBeNull();
    expect(consumed[0].consumedByUserId).toBe(owners[0].userId);
    expect(consumed[0].tokenHash).not.toContain(TOKEN);
    const [owner] = await db.select().from(user).where(eq(user.id, owners[0].userId));
    expect(owner.accountType).toBe("org");
    expect(owner.emailVerified).toBe(true);
    expect(await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, owners[0].orgId ?? ""))).toHaveLength(1);
  });

  it("stays closed after completion, across a cold cache, for replays and new claimants", async () => {
    bootstrap.resetBootstrapCache();
    expect(await bootstrap.isPlatformBootstrapped()).toBe(true);
    const late = await verifiedBrowser("late@example.invalid");
    const replay = await asBrowser(late, () => setup.completePlatformSetup(setupForm()));
    expect(replay).toMatchObject({ ok: false, error: expect.stringMatching(/already been set up/) });
    expect(await db.select().from(organisations)).toHaveLength(1);
    expect(await accountType("late@example.invalid")).toBe("seeker");
  });

  it("adopts an ownerless organisation only with the recovery token and its existing key", async () => {
    // Simulate an interrupted legacy install: organisation and vault, no owner, no bootstrap row.
    await db.execute(sql`truncate platform_bootstrap, memberships`);
    bootstrap.resetBootstrapCache();
    expect(await bootstrap.isPlatformBootstrapped()).toBe(false);
    const claimant = await verifiedBrowser("recovery@example.invalid");
    const withSetupToken = await asBrowser(claimant, () => setup.completePlatformSetup(setupForm()));
    expect(withSetupToken.ok).toBe(false);

    process.env.BOOTSTRAP_RECOVERY_TOKEN = "rc-" + "5a".repeat(24);
    try {
      const wrongKey = await asBrowser(claimant, () =>
        setup.completePlatformSetup(
          setupForm({
            bootstrapToken: process.env.BOOTSTRAP_RECOVERY_TOKEN!,
            encryptionKey: "Zb8Xq2Lm4Nc6Vd0Fe9Gh1Jk3Pw5Rt7Ys2Ua4Io6Ey8Q",
            encryptionKeyConfirm: "Zb8Xq2Lm4Nc6Vd0Fe9Gh1Jk3Pw5Rt7Ys2Ua4Io6Ey8Q",
          }),
        ),
      );
      expect(wrongKey).toMatchObject({ ok: false, error: expect.stringMatching(/existing encryption key/) });
      const recovered = await asBrowser(claimant, () =>
        setup.completePlatformSetup(setupForm({ bootstrapToken: process.env.BOOTSTRAP_RECOVERY_TOKEN! })),
      );
      expect(recovered.ok).toBe(true);
      expect(await db.select().from(vaultKeys)).toHaveLength(1);
      expect(await bootstrap.isPlatformBootstrapped()).toBe(true);
    } finally {
      delete process.env.BOOTSTRAP_RECOVERY_TOKEN;
    }
  });

  it("backfills completion for an install that predates the bootstrap row", async () => {
    await db.execute(sql`truncate platform_bootstrap`);
    bootstrap.resetBootstrapCache();
    expect(await bootstrap.isPlatformBootstrapped()).toBe(true);
    const [row] = await db.select().from(platformBootstrap);
    expect(row.consumedAt).not.toBeNull();
  });
});
