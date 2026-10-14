"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidateAccounts, memberships } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSession, requestMeta, sessionIsFresh } from "@/lib/guards";
import { getLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { readEnrollmentKey, readUnlockKey } from "@/lib/vault-enrollment";
import { activeVault, insertVaultKey, isUniqueViolation, lockVaultOwner } from "@/lib/vault-store";
import { establishVaultUnlock, readUnlockedCustomerKey } from "@/lib/vault-session";
import { verifierMatches } from "@/lib/vault-crypto";
import { cancelVaultRotation, rotateVaultKey } from "@/lib/key-rotation";
import { migrateLegacyDataKeys } from "@/lib/vault-legacy-migration";
import type { ActionResult } from "@/actions/org";

const log = getLogger("vault");
const WINDOW_MS = 15 * 60 * 1000;

async function ownerForSession() {
  const session = await getSession();
  if (!session) return { error: "Sign in required." as const };
  if ((session.user as { accountType?: string }).accountType === "org") {
    const [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    if (!membership) return { error: "Create an organisation before saving an encryption key." as const };
    return {
      session,
      ownerType: "organisation" as const,
      ownerId: membership.orgId,
      role: membership.role,
      orgId: membership.orgId as string | null,
      actorType: "org_user" as const,
      next: "/dashboard",
    };
  }
  const [candidate] = await db
    .select({ id: candidateAccounts.id })
    .from(candidateAccounts)
    .where(eq(candidateAccounts.userId, session.user.id));
  if (!candidate) return { error: "Finish account setup before saving an encryption key." as const };
  return {
    session,
    ownerType: "candidate" as const,
    ownerId: candidate.id,
    role: "owner" as const,
    orgId: null as string | null,
    actorType: "candidate" as const,
    next: "/overview",
  };
}

type Owner = Exclude<Awaited<ReturnType<typeof ownerForSession>>, { error: string }>;

/** Metadata-only audit: never the key, passphrase, or wrapped material. */
async function vaultAudit(owner: Owner, action: string, targetId: string) {
  await audit({
    orgId: owner.orgId,
    actorType: owner.actorType,
    actorId: owner.session.user.id,
    action,
    targetType: "vault_key",
    targetId,
    ...(await requestMeta()),
  });
}

/** Best-effort: move a bounded number of legacy LOCAL_KEK keys under the customer key. */
async function migrateSome(owner: Owner, crk: Buffer) {
  try {
    await migrateLegacyDataKeys({ ownerType: owner.ownerType, ownerId: owner.ownerId, crk }, { maxBatches: 5 });
  } catch {
    log.warn({ ownerType: owner.ownerType }, "legacy key migration deferred");
  }
}

export async function enrollVault(formData: FormData): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  if (owner.ownerType === "organisation" && owner.role !== "owner") {
    return { ok: false, error: "Only the organisation owner can create the encryption key." };
  }
  if (await activeVault(owner.ownerType, owner.ownerId)) {
    return { ok: false, error: "An encryption key is already enrolled. Unlock it instead." };
  }
  const material = readEnrollmentKey(formData);
  if (!material.ok) return material;
  let vault;
  try {
    vault = await db.transaction(async (tx) => {
      await lockVaultOwner(tx, owner.ownerType, owner.ownerId);
      return insertVaultKey(tx, {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        crk: material.material.crk,
        kdf: material.material.kdf,
        kdfSalt: material.material.kdfSalt,
        kdfParams: material.material.kdfParams,
      });
    });
  } catch (error) {
    // A concurrent enrolment won the one-active-key index.
    if (isUniqueViolation(error)) {
      return { ok: false, error: "An encryption key is already enrolled. Unlock it instead." };
    }
    throw error;
  }
  await establishVaultUnlock({
    vaultKeyId: vault.id,
    crk: material.material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  await vaultAudit(owner, "vault.enrolled", vault.id);
  await migrateSome(owner, material.material.crk);
  return { ok: true };
}

export async function unlockVault(formData: FormData): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  if (!(await checkRateLimit(`vault-unlock:${owner.session.user.id}`, 10, WINDOW_MS))) {
    return { ok: false, error: "Too many unlock attempts. Wait and try again." };
  }
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) return { ok: false, error: "Create an encryption key first." };
  const material = readUnlockKey(formData, vault);
  if (!material.ok || !verifierMatches(material.crk, owner.ownerType, owner.ownerId, vault.verifier)) {
    await vaultAudit(owner, "vault.unlock_failed", vault.id);
    return { ok: false, error: "That encryption key does not match." };
  }
  await establishVaultUnlock({
    vaultKeyId: vault.id,
    crk: material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  await vaultAudit(owner, "vault.unlocked", vault.id);
  await migrateSome(owner, material.crk);
  return { ok: true };
}

/** Rotation and cancellation: owner role, a recent sign-in, and a retry budget. */
async function rotationOwner(): Promise<{ owner: Owner } | { error: string }> {
  const owner = await ownerForSession();
  if ("error" in owner) return { error: owner.error ?? "Sign in required." };
  if (owner.role !== "owner") return { error: "Only the organisation owner can rotate the encryption key." };
  if (!sessionIsFresh(owner.session)) {
    return { error: "Sign out and sign in again, then retry within 15 minutes." };
  }
  if (!(await checkRateLimit(`vault-rotate:${owner.session.user.id}`, 5, WINDOW_MS))) {
    return { error: "Too many rotation attempts. Wait and try again." };
  }
  return { owner };
}

export async function rotateVault(formData: FormData): Promise<ActionResult> {
  const access = await rotationOwner();
  if ("error" in access) return { ok: false, error: access.error };
  const { owner } = access;
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) return { ok: false, error: "Create an encryption key first." };
  const current = readUnlockKey(formData, vault, "current");
  if (!current.ok) return current;
  const replacement = readEnrollmentKey(formData);
  if (!replacement.ok) return replacement;
  await vaultAudit(owner, "vault.rotation_started", vault.id);
  let result;
  try {
    result = await rotateVaultKey(
      {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        oldCrk: current.crk,
        newCrk: replacement.material.crk,
        kdf: replacement.material.kdf,
        kdfSalt: replacement.material.kdfSalt,
        kdfParams: replacement.material.kdfParams,
      },
      { maxBatches: 200 },
    );
  } catch (error) {
    await vaultAudit(owner, "vault.rotation_failed", vault.id);
    const known = error instanceof Error && error.name === "RotationError";
    return { ok: false, error: known ? (error as Error).message : "The encryption key could not be rotated." };
  }
  if (!result.completed) return { ok: true, id: "resume" };
  const active = await activeVault(owner.ownerType, owner.ownerId);
  if (!active) return { ok: false, error: "The encryption key could not be rotated." };
  await establishVaultUnlock({
    vaultKeyId: active.id,
    crk: replacement.material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  await vaultAudit(owner, "vault.rotation_completed", active.id);
  // Re-issue integration keys: those bound to the retired key were revoked.
  return { ok: true, id: result.revokedApiKeys > 0 ? `revoked:${result.revokedApiKeys}` : undefined };
}

/** Roll back a pending rotation with the current key, e.g. when the new key was lost. */
export async function cancelVaultRotationAction(formData: FormData): Promise<ActionResult> {
  const access = await rotationOwner();
  if ("error" in access) return { ok: false, error: access.error };
  const { owner } = access;
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) return { ok: false, error: "Create an encryption key first." };
  const current = readUnlockKey(formData, vault, "current");
  if (!current.ok || !verifierMatches(current.crk, owner.ownerType, owner.ownerId, vault.verifier)) {
    return { ok: false, error: "That encryption key does not match." };
  }
  try {
    const result = await cancelVaultRotation({ ownerType: owner.ownerType, ownerId: owner.ownerId, crk: current.crk });
    if (!result.cancelled) return { ok: false, error: "There is no rotation to cancel." };
  } catch (error) {
    const known = error instanceof Error && error.name === "RotationError";
    return { ok: false, error: known ? (error as Error).message : "The rotation could not be cancelled." };
  }
  await vaultAudit(owner, "vault.rotation_cancelled", vault.id);
  return { ok: true };
}

/** Explicit owner action to finish moving legacy records under the customer key. */
export async function migrateLegacyRecords(): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  if (owner.role !== "owner") return { ok: false, error: "Only the organisation owner can migrate records." };
  const crk = await readUnlockedCustomerKey(owner.ownerType, owner.ownerId);
  if (!crk) return { ok: false, error: "Unlock the encryption key first." };
  const result = await migrateLegacyDataKeys({ ownerType: owner.ownerType, ownerId: owner.ownerId, crk });
  await vaultAudit(owner, "vault.legacy_migrated", owner.ownerId);
  return { ok: true, id: `remaining:${result.remaining}` };
}
