import "server-only";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { candidateAccounts, memberships, organisations } from "@/db/schema";
import { can, type OrgRole, type Permission } from "@/lib/rbac";

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
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}
