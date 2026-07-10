"use server";

import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { memberships, organisations, user } from "@/db/schema";
import { requireOrgUser, getSession, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { ASSIGNABLE_ROLES, type OrgRole } from "@/lib/rbac";
import {
  createSendingDomain,
  getSendingDomain,
  removeSendingDomain,
  verifySendingDomain,
} from "@/lib/resend-domains";
import { getLogger } from "@/lib/logger";

const log = getLogger("org");

export type ActionResult = { ok: boolean; error?: string; id?: string };

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const suffix = createHash("sha256").update(name + Date.now()).digest("hex").slice(0, 6);
  return `${base || "org"}-${suffix}`;
}

/** Create an organisation for a fresh org-side account; caller becomes Owner. */
export async function createOrganisation(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in required." };
  if ((session.user as { accountType?: string }).accountType !== "org") {
    return { ok: false, error: "Organisation account required." };
  }
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return { ok: false, error: "Verify your email address before continuing." };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Organisation name is required." };

  const [existing] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, session.user.id));
  if (existing) return { ok: false, error: "You already belong to an organisation." };

  const [org] = await db
    .insert(organisations)
    .values({ name, slug: slugify(name) })
    .returning();

  await db.insert(memberships).values({
    orgId: org.id,
    userId: session.user.id,
    role: "owner",
  });

  const meta = await requestMeta();
  await audit({
    orgId: org.id,
    actorType: "org_user",
    actorId: session.user.id,
    action: "organisation.created",
    targetType: "organisation",
    targetId: org.id,
    ...meta,
  });

  revalidatePath("/dashboard");
  return { ok: true, id: org.id };
}

/** Add an existing org-side user to the organisation with a role. */
export async function addMember(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("users:manage");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as OrgRole;

  if (!email) return { ok: false, error: "Email is required." };
  if (!ASSIGNABLE_ROLES.includes(role)) return { ok: false, error: "Invalid role." };

  const [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) {
    return {
      ok: false,
      error: "No account with that email. Ask them to sign up as an organisation user first.",
    };
  }
  if ((u as { accountType?: string }).accountType !== "org") {
    return { ok: false, error: "That account is a job seeker account, not an organisation user." };
  }

  // Single-org invariant: a user belongs to exactly one organisation. This
  // keeps tenant resolution unambiguous (see requireOrgUser).
  const [existingMembership] = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, u.id));
  if (existingMembership) {
    return existingMembership.orgId === ctx.orgId
      ? { ok: false, error: "Already a member." }
      : { ok: false, error: "That account already belongs to another organisation." };
  }

  await db.insert(memberships).values({ orgId: ctx.orgId, userId: u.id, role });

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "membership.added",
    targetType: "user",
    targetId: u.id,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function updateMemberRole(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("users:manage");
  const membershipId = String(formData.get("membershipId") ?? "");
  const role = String(formData.get("role") ?? "") as OrgRole;
  if (!ASSIGNABLE_ROLES.includes(role)) return { ok: false, error: "Invalid role." };

  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.orgId)));
  if (!m) return { ok: false, error: "Membership not found." };
  if (m.role === "owner") return { ok: false, error: "The owner role cannot be changed here." };

  await db.update(memberships).set({ role }).where(eq(memberships.id, membershipId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "membership.role_changed",
    targetType: "membership",
    targetId: membershipId,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function removeMember(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("users:manage");
  const membershipId = String(formData.get("membershipId") ?? "");

  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, ctx.orgId)));
  if (!m) return { ok: false, error: "Membership not found." };
  if (m.role === "owner") return { ok: false, error: "The owner cannot be removed." };

  await db.delete(memberships).where(eq(memberships.id, membershipId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "membership.removed",
    targetType: "membership",
    targetId: membershipId,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function updateOrgSettings(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("retention:manage");

  const retentionDays = Number(formData.get("retentionDays") ?? 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return { ok: false, error: "Retention must be between 1 and 3650 days." };
  }
  const purgeOnClose = formData.get("purgeOnClose") === "on";
  const senderName = String(formData.get("senderName") ?? "").trim();
  const sendingDomain = String(formData.get("sendingDomain") ?? "").trim() || null;

  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, ctx.orgId));

  const domainChanged = sendingDomain !== org.sendingDomain;
  let resendDomainId = org.resendDomainId;

  // Register/clear the Resend domain when it changes (best-effort — a Resend
  // failure must not block saving the other settings).
  if (domainChanged && process.env.RESEND_API_KEY) {
    try {
      if (org.resendDomainId) await removeSendingDomain(org.resendDomainId);
      resendDomainId = null;
      if (sendingDomain) {
        const created = await createSendingDomain(sendingDomain);
        resendDomainId = created.id;
      }
    } catch (err) {
      log.error({ err, orgId: ctx.orgId }, "resend domain registration failed");
      return { ok: false, error: "Could not register the sending domain with Resend." };
    }
  }

  await db
    .update(organisations)
    .set({
      retentionDays,
      purgeOnClose,
      branding: { ...org.branding, senderName: senderName || undefined },
      sendingDomain,
      resendDomainId,
      sendingMode: sendingDomain ? "custom_domain" : "shared",
      // Actual DNS verification (SPF/DKIM via Resend) marks this; a changed
      // domain always resets to unverified.
      sendingDomainVerifiedAt: domainChanged ? null : org.sendingDomainVerifiedAt,
    })
    .where(eq(organisations.id, ctx.orgId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "organisation.settings_updated",
    targetType: "organisation",
    targetId: ctx.orgId,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

/**
 * Ask Resend to (re)check the org's sending-domain DNS. When Resend reports the
 * domain verified, stamp sendingDomainVerifiedAt so mail sends from it; a
 * pending/failed status leaves the org on the shared domain.
 */
export async function verifyDomain(): Promise<ActionResult> {
  const ctx = await requireOrgUser("retention:manage");

  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, ctx.orgId));

  if (!org.resendDomainId) {
    return { ok: false, error: "No sending domain is registered." };
  }

  let verified = false;
  try {
    await verifySendingDomain(org.resendDomainId);
    const status = await getSendingDomain(org.resendDomainId);
    verified = status?.status === "verified";
  } catch (err) {
    log.error({ err, orgId: ctx.orgId }, "resend domain verify failed");
    return { ok: false, error: "Could not reach Resend to verify the domain." };
  }

  await db
    .update(organisations)
    .set({ sendingDomainVerifiedAt: verified ? new Date() : null })
    .where(eq(organisations.id, ctx.orgId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "organisation.sending_domain_verified",
    targetType: "organisation",
    targetId: ctx.orgId,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return verified
    ? { ok: true }
    : { ok: false, error: "DNS records are not in place yet. Add them and retry." };
}
