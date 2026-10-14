import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { candidateAccounts, memberships, organisations, session, user, vaultKeys, vaultUnlocks } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { asBrowser, authRequest, newBrowser, outbox, signUpVerified, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const TOKEN = "bt-" + "3c".repeat(24);
const ORG_KEY = "Qw8Er2Ty6Ui0Op4As9Df3Gh7Jk1Lz5Xc8Vb2Nm6Qa0W";
const PASSWORD = "correct-horse-battery";

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let session_: typeof import("@/lib/vault-session");
let vaultActions: typeof import("@/actions/vault");

let ownerBrowser: Browser;
let lockedOwner: Browser;
let orgId: string;
let unenrolledAdmin: Browser;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

function enrolmentForm(key: string) {
  return form({ keyMode: "import", encryptionKey: key, encryptionKeyConfirm: key, keyBackupAck: "yes" });
}

async function signIn(email: string) {
  const browser = newBrowser();
  const response = await authRequest(browser, "/sign-in/email", { body: { email, password: PASSWORD } });
  expect(response.status).toBe(200);
  return browser;
}

async function seekerWithCandidate(email: string) {
  const browser = newBrowser();
  await signUpVerified(browser, email);
  const { requireCandidate } = await import("@/lib/guards");
  const ctx = await asBrowser(browser, () => requireCandidate());
  return { browser, candidateId: ctx.candidateAccountId };
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "33".repeat(32);
  process.env.BOOTSTRAP_TOKEN = TOKEN;
  delete process.env.ALLOW_RECRUITER_SIGNUP;
  ({ db, stop } = await setupMigratedDatabase());
  session_ = await import("@/lib/vault-session");
  vaultActions = await import("@/actions/vault");

  ownerBrowser = newBrowser();
  await signUpVerified(ownerBrowser, "owner@example.invalid");
  const { completePlatformSetup } = await import("@/actions/setup");
  const result = await asBrowser(ownerBrowser, () =>
    completePlatformSetup(
      form({ organisationName: "Vaulted Org", bootstrapToken: TOKEN, ...Object.fromEntries(enrolmentForm(ORG_KEY)) as Record<string, string> }),
    ),
  );
  expect(result.ok).toBe(true);
  orgId = result.id!;
  lockedOwner = await signIn("owner@example.invalid");

  // A second organisation that never enrolled (e.g. created before #25).
  unenrolledAdmin = newBrowser();
  await signUpVerified(unenrolledAdmin, "legacy-admin@example.invalid");
  const [legacyUser] = await db.select().from(user).where(eq(user.email, "legacy-admin@example.invalid"));
  await db.update(user).set({ accountType: "org" }).where(eq(user.id, legacyUser.id));
  const [legacyOrg] = await db.insert(organisations).values({ name: "Legacy", slug: `legacy-${randomUUID().slice(0, 6)}` }).returning();
  await db.insert(memberships).values({ orgId: legacyOrg.id, userId: legacyUser.id, role: "owner" });
});

afterAll(async () => {
  await stop?.();
});

const VAULT_ERROR = /Encryption enrollment is required|Unlock the encryption key/;

describe("vault enforcement on server actions", () => {
  it("rejects locked and unenrolled organisations on every unlocked-only action", async () => {
    const org = await import("@/actions/org");
    const requests = await import("@/actions/requests");
    const submissions = await import("@/actions/submissions");
    const alerts = await import("@/actions/job-alerts");
    const backup = await import("@/actions/backup");
    const calls: [string, () => Promise<unknown>][] = [
      ["addMember", () => org.addMember(form({ email: "x@example.invalid", role: "recruiter" }))],
      ["updateMemberRole", () => org.updateMemberRole(form({ membershipId: randomUUID(), role: "recruiter" }))],
      ["updateOrgSettings", () => org.updateOrgSettings(form({ retentionDays: "90" }))],
      ["verifyDomain", () => org.verifyDomain()],
      ["createRequest", () => requests.createRequest(form({ title: "Role" }))],
      ["sendRequest", () => requests.sendRequest(form({ requestId: randomUUID(), email: "c@example.invalid" }))],
      ["setRequestStatus", () => requests.setRequestStatus(form({ requestId: randomUUID(), status: "open" }))],
      ["shareSubmission", () => requests.shareSubmission(form({ submissionId: randomUUID() }))],
      ["setSubmissionStatus", () => submissions.setSubmissionStatus(form({ submissionId: randomUUID(), status: "reviewed" }))],
      ["updateRecruiterMatchSettings", () => alerts.updateRecruiterMatchSettings(form({}))],
      ["updateBackupSettings", () => backup.updateBackupSettings(form({}))],
      ["runBackupNow", () => backup.runBackupNow()],
    ];
    for (const [name, call] of calls) {
      await expect(asBrowser(lockedOwner, call), `${name} while locked`).rejects.toThrow(/Unlock the encryption key/);
      await expect(asBrowser(unenrolledAdmin, call), `${name} unenrolled`).rejects.toThrow(/Encryption enrollment is required/);
    }
  });

  it("allows revocation and deletion while locked but not before enrolment", async () => {
    const org = await import("@/actions/org");
    const requests = await import("@/actions/requests");
    const submissions = await import("@/actions/submissions");
    const calls: [string, () => Promise<unknown>][] = [
      ["removeMember", () => org.removeMember(form({ membershipId: randomUUID() }))],
      ["deleteTemplate", () => requests.deleteTemplate(form({ templateId: randomUUID() }))],
      ["revokeAccessToken", () => requests.revokeAccessToken(form({ accessTokenId: randomUUID() }))],
      ["deleteSubmission", () => submissions.deleteSubmission(form({ submissionId: randomUUID() }))],
    ];
    for (const [name, call] of calls) {
      await expect(asBrowser(unenrolledAdmin, call), `${name} unenrolled`).rejects.toThrow(/Encryption enrollment is required/);
      const outcome = await asBrowser(lockedOwner, call).then(
        () => "returned",
        (error: Error) => error.message,
      );
      expect(outcome, `${name} while locked`).not.toMatch(VAULT_ERROR);
    }
  });

  it("rejects seekers that are unenrolled or locked", async () => {
    const wallet = await import("@/actions/wallet");
    const alerts = await import("@/actions/job-alerts");
    const { browser: fresh } = await seekerWithCandidate("fresh-seeker@example.invalid");
    const unlocked = [
      () => wallet.toggleSavedRole(form({ requestId: randomUUID() })),
      () => wallet.upsertDiscoveryProfile(form({ discoverable: "on", clearanceLevel: "baseline" })),
      () => alerts.updateJobAlertSubscription(form({ enabled: "on" })),
    ];
    const enrolled = [
      () => wallet.deleteWalletItem(form({ itemId: randomUUID() })),
      () => wallet.deleteWalletDocument(form({ documentId: randomUUID() })),
      () => wallet.revokeWalletShare(form({ shareId: randomUUID() })),
    ];
    for (const call of [...unlocked, ...enrolled]) {
      await expect(asBrowser(fresh, call)).rejects.toThrow(/Encryption enrollment is required/);
    }
    const enrolledResult = await asBrowser(fresh, () => vaultActions.enrollVault(enrolmentForm("Pl9Ok8Ij7Uh6Yg5Tf4Rd3Es2Wa1Qz0Xs9Cd8Vf7Bg6N")));
    expect(enrolledResult.ok).toBe(true);
    const locked = await signIn("fresh-seeker@example.invalid");
    for (const call of unlocked) {
      await expect(asBrowser(locked, call)).rejects.toThrow(/Unlock the encryption key/);
    }
    for (const call of enrolled) {
      const outcome = await asBrowser(locked, call).then(() => "returned", (error: Error) => error.message);
      expect(outcome).not.toMatch(VAULT_ERROR);
    }
  });
});

describe("enrolment", () => {
  it("gives one winner and a clean answer to concurrent enrolments", async () => {
    const { browser, candidateId } = await seekerWithCandidate("racer@example.invalid");
    const keys = ["Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4C", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7Zy6X", "Mn4Bv5Cx6Zl7Kj8Hg9Fd0Sa1Qw2Er3Ty4Ui5Op6As7D"];
    const results = await Promise.all(keys.map((key) => asBrowser(browser, () => vaultActions.enrollVault(enrolmentForm(key)))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((r) => !r.ok)) expect(result.error).toMatch(/already enrolled/);
    expect(await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, candidateId))).toHaveLength(1);
  });

  it("rejects weak imported keys", async () => {
    const { browser } = await seekerWithCandidate("weak@example.invalid");
    const zero = "A".repeat(43);
    const sequential = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
    const repeating = Buffer.from(Array.from({ length: 32 }, (_, i) => [7, 99, 1, 200][i % 4])).toString("base64url");
    for (const key of [zero, sequential, repeating]) {
      const result = await asBrowser(browser, () => vaultActions.enrollVault(enrolmentForm(key)));
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not random enough/) });
    }
  });

  it("chooses the passphrase salt on the server and honours stored KDF parameters", async () => {
    const { browser, candidateId } = await seekerWithCandidate("phrase@example.invalid");
    const passphrase = "a long enough passphrase";
    const enrolled = await asBrowser(browser, () =>
      vaultActions.enrollVault(
        form({ keyMode: "passphrase", passphrase, passphraseConfirm: passphrase, kdfSalt: "AAAAAAAAAAAAAAAAAAAAAA", keyBackupAck: "yes" }),
      ),
    );
    expect(enrolled.ok).toBe(true);
    const [row] = await db.select().from(vaultKeys).where(eq(vaultKeys.ownerId, candidateId));
    expect(row.kdfSalt).not.toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(row.kdfParams).toMatchObject({ N: 131072, r: 8, p: 1, version: 2 });

    // A version-1 vault (N=2^14) still unlocks with its own stored parameters.
    const { derivePassphraseKey, generateKdfSalt } = await import("@/lib/vault-crypto");
    const { insertVaultKey } = await import("@/lib/vault-store");
    const legacy = await seekerWithCandidate("phrase-v1@example.invalid");
    const salt = generateKdfSalt();
    const v1 = { N: 16384, r: 8, p: 1, version: 1 };
    await insertVaultKey(db, {
      ownerType: "candidate",
      ownerId: legacy.candidateId,
      crk: derivePassphraseKey(passphrase, Buffer.from(salt, "base64url"), v1),
      kdf: "scrypt",
      kdfSalt: salt,
      kdfParams: v1,
    });
    const unlocked = await asBrowser(legacy.browser, () => vaultActions.unlockVault(form({ passphrase })));
    expect(unlocked.ok).toBe(true);
    await db
      .update(vaultKeys)
      .set({ kdfParams: { N: 2 ** 26, r: 8, p: 1, version: 1 } })
      .where(eq(vaultKeys.ownerId, legacy.candidateId));
    const tampered = await asBrowser(legacy.browser, () => vaultActions.unlockVault(form({ passphrase })));
    expect(tampered.ok).toBe(false);
  });
});

describe("unlock lifecycle", () => {
  it("survives refresh, not a new device, logout, expiry, password reset, or magic link", async () => {
    const read = (browser: Browser) => asBrowser(browser, () => session_.readUnlockedCustomerKey("organisation", orgId));
    expect(await read(ownerBrowser)).toBeDefined(); // refresh: same cookies, same session
    expect(await read(lockedOwner)).toBeUndefined(); // another device/session

    const device = await signIn("owner@example.invalid");
    expect((await asBrowser(device, () => vaultActions.unlockVault(form({ encryptionKey: ORG_KEY })))).ok).toBe(true);
    expect(await read(device)).toBeDefined();
    const copy: Browser = { ip: device.ip, jar: new Map(device.jar) };
    await authRequest(device, "/sign-out", { body: {} });
    expect(await read(copy)).toBeUndefined(); // stolen cookies after logout

    const expiring = await signIn("owner@example.invalid");
    await asBrowser(expiring, () => vaultActions.unlockVault(form({ encryptionKey: ORG_KEY })));
    await db.update(vaultUnlocks).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await read(expiring)).toBeUndefined();

    const [owner] = await db.select().from(user).where(eq(user.email, "owner@example.invalid"));
    const before = await db.select({ verifier: vaultKeys.verifier }).from(vaultKeys).where(eq(vaultKeys.ownerId, orgId));
    await authRequest(newBrowser(), "/request-password-reset", { body: { email: "owner@example.invalid", redirectTo: "/reset-password" } });
    const resetLink = [...outbox].reverse().find((message) => message.to === "owner@example.invalid")?.ctaUrl;
    const token = new URL(resetLink!).pathname.split("/").pop();
    const reset = await authRequest(newBrowser(), "/reset-password", { body: { newPassword: "another-horse-battery", token } });
    expect(reset.status).toBe(200);
    expect(await db.select().from(session).where(eq(session.userId, owner.id))).toHaveLength(0);
    expect(await read(ownerBrowser)).toBeUndefined();
    const after = await db.select({ verifier: vaultKeys.verifier }).from(vaultKeys).where(eq(vaultKeys.ownerId, orgId));
    expect(after).toEqual(before); // password reset never touches the encryption key

    const magic = newBrowser();
    await authRequest(magic, "/sign-in/magic-link", { body: { email: "owner@example.invalid", callbackURL: "/dashboard" } });
    const magicLink = [...outbox].reverse().find((message) => message.to === "owner@example.invalid")?.ctaUrl;
    const url = new URL(magicLink!);
    await authRequest(magic, `${url.pathname.replace(/^\/api\/auth/, "")}${url.search}`);
    expect(await db.select().from(session).where(eq(session.userId, owner.id))).toHaveLength(1);
    expect(await read(magic)).toBeUndefined();
    expect((await asBrowser(magic, () => vaultActions.unlockVault(form({ encryptionKey: ORG_KEY })))).ok).toBe(true);
    expect(await read(magic)).toBeDefined();
  });

  it("never stores the raw customer key", async () => {
    const raw = Buffer.from(ORG_KEY, "base64url");
    const rows = [
      ...(await db.select().from(vaultKeys).where(and(eq(vaultKeys.ownerId, orgId)))),
      ...(await db.select().from(vaultUnlocks)),
      ...(await db.select().from(candidateAccounts)),
    ];
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(ORG_KEY);
    expect(dump).not.toContain(raw.toString("hex"));
    expect(dump).not.toContain(raw.toString("base64"));
  });
});

describe("rotation and cancellation actions", () => {
  it("require a recent sign-in and lock out other sessions on completion", async () => {
    const oldKey = "Hy7Gt6Fr5De4Sw3Aq2Zx1Cv0Bn9Mk8Lj7Ki6Uj5Yh4T";
    const newKey = "Wq1Ea2Sd3Rf4Tg5Yh6Uj7Ik8Ol9Pz0Xc1Vb2Nm3Qa4W";
    const { browser, candidateId } = await seekerWithCandidate("rotator@example.invalid");
    expect((await asBrowser(browser, () => vaultActions.enrollVault(enrolmentForm(oldKey)))).ok).toBe(true);
    const other = await signIn("rotator@example.invalid");
    expect((await asBrowser(other, () => vaultActions.unlockVault(form({ encryptionKey: oldKey })))).ok).toBe(true);
    const rotateForm = () =>
      form({ currentEncryptionKey: oldKey, keyMode: "import", encryptionKey: newKey, encryptionKeyConfirm: newKey, keyBackupAck: "yes" });

    const [candidateUser] = await db.select().from(user).where(eq(user.email, "rotator@example.invalid"));
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(session.userId, candidateUser.id));
    const stale = await asBrowser(browser, () => vaultActions.rotateVault(rotateForm()));
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/sign in again/i) });

    await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, candidateUser.id));
    const wrongCurrent = await asBrowser(browser, () =>
      vaultActions.rotateVault(form({ ...Object.fromEntries(rotateForm()), currentEncryptionKey: newKey } as Record<string, string>)),
    );
    expect(wrongCurrent.ok).toBe(false);
    const rotated = await asBrowser(browser, () => vaultActions.rotateVault(rotateForm()));
    expect(rotated.ok).toBe(true);
    const read = (b: Browser) => asBrowser(b, () => session_.readUnlockedCustomerKey("candidate", candidateId));
    expect((await read(browser))?.equals(Buffer.from(newKey, "base64url"))).toBe(true);
    expect(await read(other)).toBeUndefined();
    expect((await asBrowser(other, () => vaultActions.unlockVault(form({ encryptionKey: oldKey })))).ok).toBe(false);
    expect((await asBrowser(other, () => vaultActions.unlockVault(form({ encryptionKey: newKey })))).ok).toBe(true);
    const cancel = await asBrowser(browser, () => vaultActions.cancelVaultRotationAction(form({ currentEncryptionKey: newKey })));
    expect(cancel).toMatchObject({ ok: false, error: expect.stringMatching(/no rotation/) });
  });

  it("refuse a non-owner organisation member", async () => {
    const memberBrowser = newBrowser();
    await signUpVerified(memberBrowser, "reviewer@example.invalid");
    const [member] = await db.select().from(user).where(eq(user.email, "reviewer@example.invalid"));
    await db.update(user).set({ accountType: "org" }).where(eq(user.id, member.id));
    await db.insert(memberships).values({ orgId, userId: member.id, role: "reviewer" });
    const result = await asBrowser(memberBrowser, () =>
      vaultActions.rotateVault(form({ currentEncryptionKey: ORG_KEY, keyMode: "generated", keyBackupAck: "yes" })),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Only the organisation owner/) });
  });
});
