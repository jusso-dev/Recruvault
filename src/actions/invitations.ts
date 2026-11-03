"use server";

import { randomUUID } from "crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { candidateAccounts, memberships, orgInvitations, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSession, requestMeta, requireEnrolledOrg, requireUnlockedOrg } from "@/lib/guards";
import {
  INVITATION_TTL_MS,
  candidateRecordFor,
  findInvitationByToken,
  invitationState,
} from "@/lib/invitations";
import { invitationLinkToken } from "@/lib/link-token";
import { enqueueEvent, publishAfterCommit } from "@/lib/outbox";
import { checkRateLimit } from "@/lib/rate-limit";
import { ASSIGNABLE_ROLES, type OrgRole } from "@/lib/rbac";
import type { ActionResult } from "./org";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Invite a teammate by email. Owners and admins only. */
export async function inviteMember(formData: FormData): Promise<ActionResult> {
  const ctx = await requireUnlockedOrg("users:manage");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as OrgRole;
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!ASSIGNABLE_ROLES.includes(role)) return { ok: false, error: "Invalid role." };
  if (!(await checkRateLimit(`invite:create:${ctx.orgId}`, 30, 60 * 60_000))) {
    return { ok: false, error: "Too many invitations sent. Wait and try again." };
  }

  const [member] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), sql`lower(${user.email}) = ${email}`));
  if (member) return { ok: false, error: "That person is already a member." };

  const invitationId = randomUUID();
  const created = await db.transaction(async (tx) => {
    // An expired invitation no longer blocks a fresh one for the same address.
    await tx
      .update(orgInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(orgInvitations.orgId, ctx.orgId),
          eq(orgInvitations.email, email),
          isNull(orgInvitations.acceptedAt),
          isNull(orgInvitations.revokedAt),
          lte(orgInvitations.expiresAt, new Date()),
        ),
      );
    const [row] = await tx
      .insert(orgInvitations)
      .values({
        id: invitationId,
        orgId: ctx.orgId,
        email,
        role,
        tokenHash: invitationLinkToken(invitationId).tokenHash,
        invitedBy: ctx.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      })
      .onConflictDoNothing()
      .returning({ id: orgInvitations.id });
    if (!row) return false;
    await enqueueEvent(tx, "org-invite/send", { invitationId }, `org-invite/send:${invitationId}`, ctx.orgId);
    return true;
  });
  if (!created) {
    return { ok: false, error: "An invitation to that address is already pending. Revoke it to send a new one." };
  }

  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "invitation.created",
    targetType: "invitation",
    targetId: invitationId,
    ...(await requestMeta()),
  });
  await publishAfterCommit();
  revalidatePath("/dashboard/settings");
  return { ok: true, id: invitationId };
}

/** Withdraw a pending invitation. Works while the vault is locked, like other revocations. */
export async function revokeInvitation(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledOrg("users:manage");
  const invitationId = String(formData.get("invitationId") ?? "");
  const [row] = await db
    .update(orgInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        sql`${orgInvitations.id}::text = ${invitationId}`,
        eq(orgInvitations.orgId, ctx.orgId),
        isNull(orgInvitations.acceptedAt),
        isNull(orgInvitations.revokedAt),
      ),
    )
    .returning({ id: orgInvitations.id });
  if (!row) return { ok: false, error: "Invitation not found or no longer pending." };

  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "invitation.revoked",
    targetType: "invitation",
    targetId: row.id,
    ...(await requestMeta()),
  });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

const CLOSED_MESSAGES = {
  accepted: "This invitation has already been used.",
  revoked: "This invitation was withdrawn. Ask the organisation for a new one.",
  expired: "This invitation has expired. Ask the organisation for a new one.",
} as const;

/**
 * Accept an invitation as the signed-in user. The account must hold a
 * verified address matching the invitation and must not already belong to an
 * organisation or hold a job seeker career record. The account type change,
 * membership, and acceptance commit together, so the token works once.
 */
export async function acceptInvitation(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "");
  const meta = await requestMeta();
  if (!(await checkRateLimit(`invite:accept:${meta.ip ?? "unknown"}`, 10, 60_000))) {
    return { ok: false, error: "Too many attempts. Wait a minute and try again." };
  }
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to accept this invitation." };
  if (!(await checkRateLimit(`invite:accept:user:${session.user.id}`, 10, 15 * 60_000))) {
    return { ok: false, error: "Too many attempts. Wait and try again." };
  }

  const found = token ? await findInvitationByToken(token) : undefined;
  if (!found) return { ok: false, error: "This invitation is not valid." };
  const state = invitationState(found.invitation);
  if (state !== "open") return { ok: false, error: CLOSED_MESSAGES[state] };
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return { ok: false, error: "Verify your email address before accepting." };
  }
  if (session.user.email.toLowerCase() !== found.invitation.email) {
    return { ok: false, error: "This invitation was sent to a different email address." };
  }

  const userId = session.user.id;
  const invitationId = found.invitation.id;
  type Outcome = { ok: true; orgId: string } | { ok: false; error: string };
  const outcome: Outcome = await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(orgInvitations)
      .where(eq(orgInvitations.id, invitationId))
      .for("update");
    const current = invitation ? invitationState(invitation) : "revoked";
    if (current !== "open") return { ok: false, error: CLOSED_MESSAGES[current] };

    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    if (existing) return { ok: false, error: "This account already belongs to an organisation." };

    const candidate = await candidateRecordFor(tx, userId, true);
    if (candidate.hasData) {
      return {
        ok: false,
        error:
          "This account holds a job seeker career record, so it cannot join an organisation. Ask the organisation to invite a different email address.",
      };
    }
    if (candidate.candidateAccountId) {
      await tx.delete(candidateAccounts).where(eq(candidateAccounts.id, candidate.candidateAccountId));
    }
    await tx.update(user).set({ accountType: "org", updatedAt: new Date() }).where(eq(user.id, userId));
    await tx.insert(memberships).values({ orgId: invitation.orgId, userId, role: invitation.role });
    await tx
      .update(orgInvitations)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(orgInvitations.id, invitationId));
    return { ok: true, orgId: invitation.orgId };
  });
  if (!outcome.ok) return outcome;

  await audit({
    orgId: outcome.orgId,
    actorType: "org_user",
    actorId: userId,
    action: "invitation.accepted",
    targetType: "invitation",
    targetId: invitationId,
    ...meta,
  });
  await audit({
    orgId: outcome.orgId,
    actorType: "org_user",
    actorId: userId,
    action: "membership.added",
    targetType: "user",
    targetId: userId,
    ...meta,
  });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}
