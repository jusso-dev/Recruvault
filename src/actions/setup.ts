"use server";

import { createHash } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organisations, platformBootstrap, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { tokenMatches } from "@/lib/crypto";
import { getSession, requestMeta } from "@/lib/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { readEnrollmentKey } from "@/lib/vault-enrollment";
import { insertVaultKey } from "@/lib/vault-store";
import { establishVaultUnlock } from "@/lib/vault-session";
import type { ActionResult } from "@/actions/org";

function organisationSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const suffix = createHash("sha256").update(`${name}:${Date.now()}`).digest("hex").slice(0, 6);
  return `${base || "organisation"}-${suffix}`;
}

async function capabilityOk(presented: string, expected: string | undefined, ip: string) {
  const allowed = await checkRateLimit(`bootstrap:${ip || "unknown"}`, 5, 15 * 60 * 1000);
  if (!allowed) return "Too many setup attempts. Wait and try again.";
  if (!expected || expected.length < 32 || !tokenMatches(presented, expected)) {
    return "The bootstrap token is not valid.";
  }
  return null;
}

/** Complete the one-time platform bootstrap after the owner verifies their email. */
export async function completePlatformSetup(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your account was created, but the session could not be started. Sign in and try again." };
  if ((session.user as { accountType?: string }).accountType !== "org") {
    return { ok: false, error: "A recruiter account is required for setup." };
  }
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return { ok: false, error: "Verify your email address before continuing." };
  }

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const organisationName = String(formData.get("organisationName") ?? "").trim();
  if (!organisationName) return { ok: false, error: "Enter your organisation name." };

  const material = readEnrollmentKey(formData);
  if (!material.ok) return material;

  const meta = await requestMeta();
  const presented = String(formData.get("bootstrapToken") ?? "");

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(814726391)`);
    const [owner] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.role, "owner"))
      .limit(1);
    if (owner) return { existing: true as const };

    const [organisation] = await tx.select({ id: organisations.id }).from(organisations).limit(1);
    const recovery = Boolean(organisation);
    const tokenError = await capabilityOk(
      presented,
      recovery ? process.env.BOOTSTRAP_RECOVERY_TOKEN : process.env.BOOTSTRAP_TOKEN,
      meta.ip ?? "unknown",
    );
    if (tokenError) return { existing: false as const, error: tokenError };

    if (firstName || lastName) {
      await tx
        .update(user)
        .set({
          name: `${firstName || session.user.name} ${lastName}`.trim(),
          accountType: "org",
          updatedAt: new Date(),
        })
        .where(sql`${user.id} = ${session.user.id}`);
    }

    const organisationId = organisation
      ? organisation.id
      : (
          await tx
            .insert(organisations)
            .values({ name: organisationName, slug: organisationSlug(organisationName) })
            .returning({ id: organisations.id })
        )[0].id;

    await tx.insert(memberships).values({
      orgId: organisationId,
      userId: session.user.id,
      role: "owner",
    });
    const vault = await insertVaultKey(tx, {
      ownerType: "organisation",
      ownerId: organisationId,
      crk: material.material.crk,
      kdf: material.material.kdf,
      kdfSalt: material.material.kdfSalt,
      kdfParams: material.material.kdfParams,
    });
    await tx
      .insert(platformBootstrap)
      .values({
        id: "platform",
        tokenHash: createHash("sha256").update(presented).digest("hex"),
        consumedAt: new Date(),
        consumedByUserId: session.user.id,
      })
      .onConflictDoUpdate({
        target: platformBootstrap.id,
        set: { consumedAt: new Date(), consumedByUserId: session.user.id },
      });
    return { existing: false as const, organisationId, vaultKeyId: vault.id };
  });

  if (result.existing) return { ok: false, error: "Recruvault has already been set up. Sign in instead." };
  if (!("vaultKeyId" in result) || !result.vaultKeyId || !result.organisationId) {
    return { ok: false, error: "error" in result && result.error ? result.error : "Setup could not be completed." };
  }

  await establishVaultUnlock({
    vaultKeyId: result.vaultKeyId,
    crk: material.material.crk,
    sessionId: session.session.id,
    expiresAt: session.session.expiresAt,
  });
  await audit({
    orgId: result.organisationId,
    actorType: "org_user",
    actorId: session.user.id,
    action: "platform.setup_completed",
    targetType: "organisation",
    targetId: result.organisationId,
    ...meta,
  });
  return { ok: true, id: result.organisationId };
}
