import "server-only";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { candidateAccounts, memberships, organisations, user } from "@/db/schema";
import { can, type OrgRole, type Permission } from "@/lib/rbac";
import { clientIp } from "@/lib/client-ip";

/**
 * Data-layer authorisation. Every server action and route handler resolves
 * its caller through these guards; tenant (org_id) and ownership checks are
 * applied here, not in the UI.
 */

export class AuthError extends Error {
  constructor(message = "Not authorised.") {
    super(message);
    this.name = "AuthError";
  }
}

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export interface OrgContext {
  userId: string;
  userEmail: string;
  userName: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: OrgRole;
}

export type OrgAccessResult =
  | { ok: true; context: OrgContext }
  | {
      ok: false;
      reason:
        | "sign_in"
        | "wrong_account"
        | "verification_required"
        | "no_membership"
        | "ambiguous_membership"
        | "permission_denied";
      message: string;
    };

/**
 * Resolve the signed-in organisation user and their active membership as an
 * explicit result so Server Components can render or redirect expected states.
 */
export async function resolveOrgUser(permission?: Permission): Promise<OrgAccessResult> {
  const session = await getSession();
  if (!session) return { ok: false, reason: "sign_in", message: "Sign in required." };
  if ((session.user as { accountType?: string }).accountType !== "org") {
    return {
      ok: false,
      reason: "wrong_account",
      message: "Organisation account required.",
    };
  }
  // Org accounts must verify their email before acting: createOrganisation and
  // addMember trust the address for membership matching, so an unverified one
  // must not be able to create orgs or send requests.
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return {
      ok: false,
      reason: "verification_required",
      message: "Verify your email address before continuing.",
    };
  }

  const rows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      orgSlug: organisations.slug,
      orgName: organisations.name,
    })
    .from(memberships)
    .innerJoin(organisations, eq(organisations.id, memberships.orgId))
    .where(eq(memberships.userId, session.user.id));

  if (rows.length === 0) {
    return {
      ok: false,
      reason: "no_membership",
      message: "No organisation membership.",
    };
  }
  // Single-org invariant (enforced at membership creation). More than one
  // membership is ambiguous with no active-org selector, so fail closed rather
  // than silently resolve to an arbitrary tenant's data.
  if (rows.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_membership",
      message: "Account belongs to multiple organisations; contact support.",
    };
  }
  const m = rows[0];
  if (permission && !can(m.role, permission)) {
    return {
      ok: false,
      reason: "permission_denied",
      message: `Your role does not allow this action (${permission}).`,
    };
  }

  return {
    ok: true,
    context: {
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
      orgId: m.orgId,
      orgSlug: m.orgSlug,
      orgName: m.orgName,
      role: m.role,
    },
  };
}

export async function requireOrgUser(permission?: Permission): Promise<OrgContext> {
  const access = await resolveOrgUser(permission);
  if (!access.ok) throw new AuthError(access.message);
  return access.context;
}

export interface CandidateContext {
  userId: string;
  userEmail: string;
  userName: string;
  candidateAccountId: string;
}

/**
 * Resolve the signed-in job seeker, creating their candidate_accounts row on
 * first access. Job seekers are scoped strictly to their own data.
 */
export async function requireCandidate(): Promise<CandidateContext> {
  const session = await getSession();
  if (!session) throw new AuthError("Sign in required.");
  if ((session.user as { accountType?: string }).accountType === "org") {
    throw new AuthError("Job seeker account required.");
  }

  const [account] = await db
    .select({ erasedAt: user.erasedAt })
    .from(user)
    .where(eq(user.id, session.user.id));
  if (account?.erasedAt) throw new AuthError("This account has been deleted.");

  let [ca] = await db
    .select()
    .from(candidateAccounts)
    .where(eq(candidateAccounts.userId, session.user.id));

  if (!ca) {
    [ca] = await db
      .insert(candidateAccounts)
      .values({ userId: session.user.id })
      .onConflictDoNothing()
      .returning();
    if (!ca) {
      [ca] = await db
        .select()
        .from(candidateAccounts)
        .where(eq(candidateAccounts.userId, session.user.id));
    }
  }

  return {
    userId: session.user.id,
    userEmail: session.user.email,
    userName: session.user.name,
    candidateAccountId: ca.id,
  };
}

export interface UnlockedVault {
  crk: Buffer;
  vaultKeyId: string;
  vaultVersion: number;
}

/**
 * Vault enforcement for Server Actions and route handlers. "Enrolled" is
 * required for every workspace action; "unlocked" additionally requires this
 * session to hold the customer key, and is used wherever protected data is
 * read, written, encrypted, or a capability (link, share, key) is issued.
 * Revocation and deletion only need enrolment so they stay possible while
 * locked.
 */
async function vaultFor(ownerType: "organisation" | "candidate", ownerId: string) {
  const { activeVault } = await import("@/lib/vault-store");
  const vault = await activeVault(ownerType, ownerId);
  if (!vault) throw new AuthError("Encryption enrollment is required.");
  return vault;
}

async function unlockedVaultFor(
  ownerType: "organisation" | "candidate",
  ownerId: string,
): Promise<UnlockedVault> {
  const vault = await vaultFor(ownerType, ownerId);
  const { readUnlockedCustomerKey } = await import("@/lib/vault-session");
  const crk = await readUnlockedCustomerKey(ownerType, ownerId);
  if (!crk) throw new AuthError("Unlock the encryption key before continuing.");
  return { crk, vaultKeyId: vault.id, vaultVersion: vault.version };
}

export async function requireEnrolledOrg(permission?: Permission): Promise<OrgContext> {
  const ctx = await requireOrgUser(permission);
  await vaultFor("organisation", ctx.orgId);
  return ctx;
}

export async function requireUnlockedOrg(
  permission?: Permission,
): Promise<OrgContext & UnlockedVault> {
  const ctx = await requireOrgUser(permission);
  return { ...ctx, ...(await unlockedVaultFor("organisation", ctx.orgId)) };
}

export async function requireEnrolledCandidate(): Promise<CandidateContext> {
  const ctx = await requireCandidate();
  await vaultFor("candidate", ctx.candidateAccountId);
  return ctx;
}

export async function requireUnlockedCandidate(): Promise<CandidateContext & UnlockedVault> {
  const ctx = await requireCandidate();
  return { ...ctx, ...(await unlockedVaultFor("candidate", ctx.candidateAccountId)) };
}

/** Recent sign-in for sensitive key operations (rotation, cancellation). */
export function sessionIsFresh(session: { session: { createdAt: Date | string } }, maxAgeMs = 15 * 60 * 1000) {
  return Date.now() - new Date(session.session.createdAt).getTime() <= maxAgeMs;
}

/** Assert a row belongs to the caller's organisation. */
export async function assertOrgMembershipRole(
  orgId: string,
  userId: string,
): Promise<OrgRole> {
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!m) throw new AuthError("Not a member of this organisation.");
  return m.role;
}

export async function requestMeta() {
  const h = await headers();
  // Same trusted-proxy rule as API rate limiting; null when no usable address.
  const ip = clientIp(h);
  return {
    ip: ip === "unknown" || ip === "untrusted" ? null : ip,
    userAgent: h.get("user-agent"),
  };
}
