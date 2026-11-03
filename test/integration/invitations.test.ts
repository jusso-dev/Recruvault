import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  memberships,
  orgInvitations,
  outboxEvents,
  submissionShares,
  submissions,
  user,
} from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { asBrowser, authRequest, newBrowser, signUpVerified, type Browser } from "./request-context";
import { createRequestWithLink, createSubmission } from "./fixtures";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const TOKEN = "bt-" + "5e".repeat(24);
const ORG_KEY = "Zx8Cv2Bn6Mq0Wp4Er9Ty3Ui7Op1As5Df8Gh2Jk6Lz0Q";
const SEEKER_KEY = "Pl9Ok3Ij7Uh1Yg5Tf0Rd4Es8Wa2Qz6Xc1Vb5Nm9Hj3K";
const PASSWORD = "correct-horse-battery";

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let actions: typeof import("@/actions/invitations");
let invitations: typeof import("@/lib/invitations");
let owner: Browser;
let orgId: string;
let ownerId: string;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

function enrolment(key: string) {
  return { keyMode: "import", encryptionKey: key, encryptionKeyConfirm: key, keyBackupAck: "yes" };
}

/** Invite as the owner and capture the emailed link through the real worker. */
async function invite(email: string, role = "recruiter") {
  const result = await asBrowser(owner, () => actions.inviteMember(form({ email, role })));
  expect(result.ok, result.error).toBe(true);
  const sent: { to: string; link: string }[] = [];
  const outcome = await invitations.sendInvitationEmail(result.id!, async (message) => {
    sent.push({ to: message.to, link: message.link });
    return "message-id";
  });
  expect(outcome).toBe("sent");
  expect(sent).toHaveLength(1);
  const token = new URL(sent[0].link).pathname.replace(/^\/invite\//, "");
  return { id: result.id!, token, to: sent[0].to };
}

async function verifiedUser(email: string) {
  const browser = newBrowser();
  await signUpVerified(browser, email);
  return browser;
}

function accept(browser: Browser, token: string, password = PASSWORD) {
  return asBrowser(browser, () => actions.acceptInvitation(form({ token, password })));
}

async function userRow(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  return row;
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "44".repeat(32);
  process.env.BOOTSTRAP_TOKEN = TOKEN;
  delete process.env.ALLOW_RECRUITER_SIGNUP;
  ({ db, stop } = await setupMigratedDatabase());
  actions = await import("@/actions/invitations");
  invitations = await import("@/lib/invitations");

  owner = newBrowser();
  await signUpVerified(owner, "owner@example.invalid");
  const { completePlatformSetup } = await import("@/actions/setup");
  const result = await asBrowser(owner, () =>
    completePlatformSetup(form({ organisationName: "Invite Org", bootstrapToken: TOKEN, ...enrolment(ORG_KEY) })),
  );
  expect(result.ok).toBe(true);
  orgId = result.id!;
  ownerId = (await userRow("owner@example.invalid")).id;
});

afterAll(async () => {
  await stop?.();
});

describe("teammate invitations", () => {
  it("emails a single-use link whose token is never stored or queued", async () => {
    const sent = await invite("Teammate@Example.invalid");
    expect(sent.to).toBe("teammate@example.invalid");

    const [row] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, sent.id));
    expect(row.email).toBe("teammate@example.invalid");
    expect(row.tokenHash).not.toContain(sent.token);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "org-invite/send"));
    expect(events.map((e) => e.payload)).toContainEqual({ invitationId: sent.id });
    expect(JSON.stringify(events)).not.toContain(sent.token);

    // Replayed delivery does not send twice.
    const again = await invitations.sendInvitationEmail(sent.id, async () => "second");
    expect(again).toBe("duplicate");

    // A second open invitation to the same address is refused.
    const duplicate = await asBrowser(owner, () =>
      actions.inviteMember(form({ email: "teammate@example.invalid", role: "reviewer" })),
    );
    expect(duplicate).toMatchObject({ ok: false, error: expect.stringMatching(/already pending/) });
  });

  it("accepts once for a verified matching account and still requires the vault key", async () => {
    // Addresses match case-insensitively.
    const sent = await invite("Joiner@EXAMPLE.invalid", "reviewer");
    const joiner = await verifiedUser("joiner@example.invalid");

    const result = await accept(joiner, sent.token);
    expect(result).toEqual({ ok: true });

    const account = await userRow("joiner@example.invalid");
    expect(account.accountType).toBe("org");
    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, account.id));
    expect(membership).toMatchObject({ orgId, role: "reviewer" });
    const [row] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, sent.id));
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedBy).toBe(account.id);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.targetId, sent.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["invitation.created", "invitation.accepted"]));

    // Single use.
    const reuse = await accept(joiner, sent.token);
    expect(reuse).toMatchObject({ ok: false, error: expect.stringMatching(/already been used/) });

    // Membership alone does not open the vault: the customer key is still required.
    const { requireUnlockedOrg } = await import("@/lib/guards");
    await expect(asBrowser(joiner, () => requireUnlockedOrg())).rejects.toThrow(/Unlock the encryption key/);
    const { unlockVault } = await import("@/actions/vault");
    const unlocked = await asBrowser(joiner, () => unlockVault(form({ encryptionKey: ORG_KEY })));
    expect(unlocked.ok).toBe(true);
    await expect(asBrowser(joiner, () => requireUnlockedOrg())).resolves.toMatchObject({ orgId });
  });

  it("rejects a different email address", async () => {
    const sent = await invite("intended@example.invalid");
    const other = await verifiedUser("someone-else@example.invalid");
    const result = await accept(other, sent.token);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/different email/) });
    expect((await userRow("someone-else@example.invalid")).accountType).toBe("seeker");
  });

  it("rejects an unverified address", async () => {
    const sent = await invite("unverified@example.invalid");
    const browser = newBrowser();
    await signUpVerified(browser, "unverified@example.invalid", { verify: false });
    const result = await accept(browser, sent.token);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Verify your email/) });
  });

  it("rejects expired and revoked invitations", async () => {
    const expired = await invite("late@example.invalid");
    await db
      .update(orgInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(orgInvitations.id, expired.id));
    const late = await verifiedUser("late@example.invalid");
    expect(await accept(late, expired.token)).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });

    // An expired invitation no longer blocks a fresh one.
    const fresh = await invite("late@example.invalid");
    expect(fresh.id).not.toBe(expired.id);

    const revoked = await invite("revoked@example.invalid");
    const outcome = await asBrowser(owner, () => actions.revokeInvitation(form({ invitationId: revoked.id })));
    expect(outcome.ok).toBe(true);
    expect(await invitations.sendInvitationEmail(revoked.id, async () => "x")).toBe("skipped");
    const invitee = await verifiedUser("revoked@example.invalid");
    expect(await accept(invitee, revoked.token)).toMatchObject({ ok: false, error: expect.stringMatching(/withdrew|withdrawn/) });
    expect((await userRow("revoked@example.invalid")).accountType).toBe("seeker");
  });

  it("rejects an unknown token", async () => {
    const browser = await verifiedUser("nobody@example.invalid");
    expect(await accept(browser, "not-a-real-token-value-at-all")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid/) });
  });

  it("refuses a job seeker account that holds a career record", async () => {
    const sent = await invite("seeker@example.invalid");
    const seeker = await verifiedUser("seeker@example.invalid");
    const { requireCandidate } = await import("@/lib/guards");
    await asBrowser(seeker, () => requireCandidate());
    const { enrollVault } = await import("@/actions/vault");
    expect((await asBrowser(seeker, () => enrollVault(form(enrolment(SEEKER_KEY))))).ok).toBe(true);

    const result = await accept(seeker, sent.token);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/career record/) });
    const account = await userRow("seeker@example.invalid");
    expect(account.accountType).toBe("seeker");
    expect(await db.select().from(memberships).where(eq(memberships.userId, account.id))).toHaveLength(0);
    const [row] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, sent.id));
    expect(row.acceptedAt).toBeNull();
  });

  it("converts a job seeker account with no career data", async () => {
    const sent = await invite("blank@example.invalid");
    const blank = await verifiedUser("blank@example.invalid");
    const { requireCandidate } = await import("@/lib/guards");
    await asBrowser(blank, () => requireCandidate());
    expect(await accept(blank, sent.token)).toEqual({ ok: true });
    expect((await userRow("blank@example.invalid")).accountType).toBe("org");
  });

  it("does not let non-admins invite or revoke", async () => {
    const sent = await invite("recruiter@example.invalid", "recruiter");
    const recruiter = await verifiedUser("recruiter@example.invalid");
    expect(await accept(recruiter, sent.token)).toEqual({ ok: true });
    const { unlockVault } = await import("@/actions/vault");
    expect((await asBrowser(recruiter, () => unlockVault(form({ encryptionKey: ORG_KEY })))).ok).toBe(true);

    await expect(
      asBrowser(recruiter, () => actions.inviteMember(form({ email: "x@example.invalid", role: "admin" }))),
    ).rejects.toThrow(/role does not allow/);
    const pending = await invite("pending@example.invalid");
    await expect(
      asBrowser(recruiter, () => actions.revokeInvitation(form({ invitationId: pending.id }))),
    ).rejects.toThrow(/role does not allow/);
  });
});

describe("reviewer sharing", () => {
  it("lets the request owner remove a reviewer's access, but not the reviewer", async () => {
    const sent = await invite("share-reviewer@example.invalid", "reviewer");
    const reviewer = await verifiedUser("share-reviewer@example.invalid");
    expect(await accept(reviewer, sent.token)).toEqual({ ok: true });
    const reviewerId = (await userRow("share-reviewer@example.invalid")).id;

    const link = await createRequestWithLink(db, { orgId, ownerUserId: ownerId });
    const submissionId = await createSubmission(db, link);
    await db.insert(submissionShares).values({ submissionId, userId: reviewerId });

    const { assertSubmissionAccess } = await import("@/lib/review");
    const { requireOrgUser } = await import("@/lib/guards");
    const reviewerCtx = await asBrowser(reviewer, () => requireOrgUser());
    await expect(assertSubmissionAccess(reviewerCtx, submissionId)).resolves.toBeTruthy();

    const { unshareSubmission } = await import("@/actions/submissions");
    const denied = await asBrowser(reviewer, () => unshareSubmission(form({ submissionId, userId: reviewerId })));
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/role owner or an admin/) });

    const removed = await asBrowser(owner, () => unshareSubmission(form({ submissionId, userId: reviewerId })));
    expect(removed).toEqual({ ok: true });
    await expect(assertSubmissionAccess(reviewerCtx, submissionId)).rejects.toThrow(/not been shared/);
    const again = await asBrowser(owner, () => unshareSubmission(form({ submissionId, userId: reviewerId })));
    expect(again.ok).toBe(false);
  });
});

describe("application withdrawal", () => {
  it("lets only the owning job seeker withdraw an active application", async () => {
    const { requireCandidate } = await import("@/lib/guards");
    const { enrollVault } = await import("@/actions/vault");
    const { withdrawApplication } = await import("@/actions/wallet");

    const applicant = await verifiedUser("applicant@example.invalid");
    const mine = await asBrowser(applicant, () => requireCandidate());
    expect((await asBrowser(applicant, () => enrollVault(form(enrolment(SEEKER_KEY))))).ok).toBe(true);
    const other = await verifiedUser("other-applicant@example.invalid");
    await asBrowser(other, () => requireCandidate());
    expect((await asBrowser(other, () => enrollVault(form(enrolment(SEEKER_KEY))))).ok).toBe(true);

    const link = await createRequestWithLink(db, { orgId, ownerUserId: ownerId });
    const submissionId = await createSubmission(db, link, { candidateAccountId: mine.candidateAccountId });

    const denied = await asBrowser(other, () => withdrawApplication(form({ submissionId })));
    expect(denied.ok).toBe(false);
    const [untouched] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(untouched.status).toBe("received");

    // Signing in again leaves the vault locked; withdrawal needs only enrolment.
    const locked = newBrowser();
    const signIn = await authRequest(locked, "/sign-in/email", {
      body: { email: "applicant@example.invalid", password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    expect(await asBrowser(locked, () => withdrawApplication(form({ submissionId })))).toEqual({ ok: true });
    const [withdrawn] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(withdrawn.status).toBe("withdrawn");
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, submissionId), eq(auditEvents.action, "submission.status.withdrawn")));
    expect(event).toMatchObject({ orgId, actorType: "candidate" });

    // Already withdrawn: nothing left to withdraw.
    expect((await asBrowser(applicant, () => withdrawApplication(form({ submissionId })))).ok).toBe(false);
  });
});

describe("invitation hardening", () => {
  it("needs the account password and signs out every other session", async () => {
    const sent = await invite("pre-registered@example.invalid");
    // Someone else may have registered this address first and kept a session.
    const squatter = await verifiedUser("pre-registered@example.invalid");
    const invitee = newBrowser();
    const signIn = await authRequest(invitee, "/sign-in/email", {
      body: { email: "pre-registered@example.invalid", password: PASSWORD },
    });
    expect(signIn.status).toBe(200);

    expect(await accept(invitee, sent.token, "")).toMatchObject({ ok: false, error: expect.stringMatching(/password/) });
    expect(await accept(invitee, sent.token, "not-the-password")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not correct/),
    });
    expect(await accept(invitee, sent.token)).toEqual({ ok: true });

    const { getSession } = await import("@/lib/guards");
    expect(await asBrowser(squatter, () => getSession())).toBeNull();
    expect(await asBrowser(invitee, () => getSession())).not.toBeNull();
  });

  it("ends with the sender's authority", async () => {
    const { removeMember, updateMemberRole } = await import("@/actions/org");
    const { unlockVault } = await import("@/actions/vault");
    const adminInvite = await invite("inviting-admin@example.invalid", "admin");
    const admin = await verifiedUser("inviting-admin@example.invalid");
    expect(await accept(admin, adminInvite.token)).toEqual({ ok: true });
    expect((await asBrowser(admin, () => unlockVault(form({ encryptionKey: ORG_KEY })))).ok).toBe(true);
    const adminId = (await userRow("inviting-admin@example.invalid")).id;
    const [adminMembership] = await db.select().from(memberships).where(eq(memberships.userId, adminId));

    const sendAs = async (email: string) => {
      const result = await asBrowser(admin, () => actions.inviteMember(form({ email, role: "admin" })));
      expect(result.ok, result.error).toBe(true);
      const sent: string[] = [];
      await invitations.sendInvitationEmail(result.id!, async (message) => {
        sent.push(message.link);
        return "message-id";
      });
      return { id: result.id!, token: new URL(sent[0]).pathname.replace(/^\/invite\//, "") };
    };

    // Demoted: invitations the admin sent are revoked.
    const beforeDemotion = await sendAs("demoted-admin-guest@example.invalid");
    expect(
      (await asBrowser(owner, () =>
        updateMemberRole(form({ membershipId: adminMembership.id, role: "recruiter" })),
      )).ok,
    ).toBe(true);
    const [revoked] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, beforeDemotion.id));
    expect(revoked.revokedAt).not.toBeNull();

    // An invitation whose sender no longer manages users cannot be accepted,
    // even if it was somehow left open.
    await db.update(orgInvitations).set({ revokedAt: null }).where(eq(orgInvitations.id, beforeDemotion.id));
    const guest = await verifiedUser("demoted-admin-guest@example.invalid");
    expect(await accept(guest, beforeDemotion.token)).toMatchObject({ ok: false });
    expect(await db.select().from(memberships).where(eq(memberships.userId, (await userRow("demoted-admin-guest@example.invalid")).id))).toHaveLength(0);

    // Removed: the same applies.
    expect(
      (await asBrowser(owner, () => updateMemberRole(form({ membershipId: adminMembership.id, role: "admin" })))).ok,
    ).toBe(true);
    const beforeRemoval = await sendAs("removed-admin-guest@example.invalid");
    expect((await asBrowser(owner, () => removeMember(form({ membershipId: adminMembership.id })))).ok).toBe(true);
    const [afterRemoval] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, beforeRemoval.id));
    expect(afterRemoval.revokedAt).not.toBeNull();
  });
});
