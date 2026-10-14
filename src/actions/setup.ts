"use server";

import { createHash } from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { candidateAccounts, memberships, organisations, platformBootstrap, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { tokenMatches } from "@/lib/crypto";
import { getSession, requestMeta } from "@/lib/guards";
import { BOOTSTRAP_LOCK } from "@/lib/platform-bootstrap";
import { checkRateLimit } from "@/lib/rate-limit";
import { readEnrollmentKey, readUnlockKey } from "@/lib/vault-enrollment";
import { activeVault, insertVaultKey } from "@/lib/vault-store";
import { establishVaultUnlock } from "@/lib/vault-session";
import { verifierMatches } from "@/lib/vault-crypto";
import type { ActionResult } from "@/actions/org";

const WINDOW_MS = 15 * 60 * 1000;

function organisationSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const suffix = createHash("sha256").update(`${name}:${Date.now()}`).digest("hex").slice(0, 6);
  return `${base || "organisation"}-${suffix}`;
}

/**
 * Throttle per client and globally: x-forwarded-for can be rotated, so a
 * deployment-wide budget caps total guesses regardless of claimed source.
 */
async function attemptAllowed(ip: string | null) {
  const perClient = await checkRateLimit(`bootstrap:${ip || "unknown"}`, 5, WINDOW_MS);
  const global = await checkRateLimit("bootstrap:global", 30, WINDOW_MS);
  return perClient && global;
}

function capabilityOk(presented: string, expected: string | undefined) {
  return Boolean(expected && expected.length >= 32 && presented && tokenMatches(presented, expected));
}

/**
 * Complete the one-time platform bootstrap. The caller must hold a verified
 * BetterAuth session (verification comes from the emailed link, never from
 * this action) and the operator's BOOTSTRAP_TOKEN. The account type, the
 * organisation, the owner membership, the vault key, and the consumed
 * bootstrap row are written in one transaction under an advisory lock.
 */
export async function completePlatformSetup(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in with the account you created, then continue setup." };
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return { ok: false, error: "Verify your email address before continuing." };
  }

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const organisationName = String(formData.get("organisationName") ?? "").trim();
  const presented = String(formData.get("bootstrapToken") ?? "");
  if (!presented) return { ok: false, error: "Enter the bootstrap token." };

  const meta = await requestMeta();
  if (!(await attemptAllowed(meta.ip))) return { ok: false, error: "Too many setup attempts. Wait and try again." };

  type Outcome =
    | { kind: "done"; organisationId: string; vaultKeyId: string; crk: Buffer }
    | { kind: "error"; error: string };

  const result: Outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
    const [consumed] = await tx
      .select({ id: platformBootstrap.id })
      .from(platformBootstrap)
      .where(and(eq(platformBootstrap.id, "platform"), isNotNull(platformBootstrap.consumedAt)));
    const [owner] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.role, "owner"))
      .limit(1);
    if (consumed || owner) return { kind: "error", error: "Recruvault has already been set up. Sign in instead." };

    // An organisation without an owner means an interrupted earlier install;
    // only the separate operator recovery token may adopt it.
    const [organisation] = await tx.select({ id: organisations.id }).from(organisations).limit(1);
    const expected = organisation ? process.env.BOOTSTRAP_RECOVERY_TOKEN : process.env.BOOTSTRAP_TOKEN;
    if (!capabilityOk(presented, expected)) return { kind: "error", error: "The bootstrap token is not valid." };
    if (!organisation && !organisationName) return { kind: "error", error: "Enter your organisation name." };

    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    const [candidate] = await tx
      .select({ id: candidateAccounts.id })
      .from(candidateAccounts)
      .where(eq(candidateAccounts.userId, session.user.id));
    if (membership || candidate) {
      return { kind: "error", error: "Use a new account for the first owner." };
    }

    const organisationId = organisation
      ? organisation.id
      : (
          await tx
            .insert(organisations)
            .values({ name: organisationName, slug: organisationSlug(organisationName) })
            .returning({ id: organisations.id })
        )[0].id;

    // An adopted organisation may already have a vault: the claimant must
    // prove they hold that key rather than enrolling over it.
    const existingVault = organisation ? await activeVault("organisation", organisationId) : null;
    let vaultKeyId: string;
    let crk: Buffer;
    if (existingVault) {
      const key = readUnlockKey(formData, existingVault);
      if (!key.ok || !verifierMatches(key.crk, "organisation", organisationId, existingVault.verifier)) {
        return { kind: "error", error: "Enter the organisation's existing encryption key." };
      }
      vaultKeyId = existingVault.id;
      crk = key.crk;
    } else {
      const material = readEnrollmentKey(formData);
      if (!material.ok) return { kind: "error", error: material.error };
      const vault = await insertVaultKey(tx, {
        ownerType: "organisation",
        ownerId: organisationId,
        crk: material.material.crk,
        kdf: material.material.kdf,
        kdfSalt: material.material.kdfSalt,
        kdfParams: material.material.kdfParams,
      });
      vaultKeyId = vault.id;
      crk = material.material.crk;
    }

    await tx
      .update(user)
      .set({
        ...(firstName || lastName ? { name: `${firstName || session.user.name} ${lastName}`.trim() } : {}),
        accountType: "org",
        updatedAt: new Date(),
      })
      .where(eq(user.id, session.user.id));
    await tx.insert(memberships).values({ orgId: organisationId, userId: session.user.id, role: "owner" });
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
    return { kind: "done", organisationId, vaultKeyId, crk };
  });

  if (result.kind === "error") {
    await audit({
      actorType: "system",
      actorId: session.user.id,
      action: "platform.setup_rejected",
      targetType: "platform",
      targetId: "platform",
      ...meta,
    });
    return { ok: false, error: result.error };
  }

  await establishVaultUnlock({
    vaultKeyId: result.vaultKeyId,
    crk: result.crk,
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
