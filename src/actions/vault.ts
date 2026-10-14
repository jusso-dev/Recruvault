"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidateAccounts, memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { readEnrollmentKey, readUnlockKey } from "@/lib/vault-enrollment";
import { activeVault, insertVaultKey } from "@/lib/vault-store";
import { establishVaultUnlock } from "@/lib/vault-session";
import { verifierMatches } from "@/lib/vault-crypto";
import { rotateVaultKey } from "@/lib/key-rotation";
import type { ActionResult } from "@/actions/org";

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
    next: "/overview",
  };
}

export async function enrollVault(formData: FormData): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  if (owner.ownerType === "organisation" && owner.role !== "owner") {
    return { ok: false, error: "Only the organisation owner can create the encryption key." };
  }
  const existing = await activeVault(owner.ownerType, owner.ownerId);
  if (existing) return { ok: false, error: "An encryption key is already enrolled." };
  const material = readEnrollmentKey(formData);
  if (!material.ok) return material;
  const vault = await insertVaultKey(db, {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    crk: material.material.crk,
    kdf: material.material.kdf,
    kdfSalt: material.material.kdfSalt,
    kdfParams: material.material.kdfParams,
  });
  await establishVaultUnlock({
    vaultKeyId: vault.id,
    crk: material.material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  return { ok: true };
}

export async function unlockVault(formData: FormData): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) return { ok: false, error: "Create an encryption key first." };
  const material = readUnlockKey(formData, vault);
  if (!material.ok) return material;
  if (!verifierMatches(material.crk, owner.ownerType, owner.ownerId, vault.verifier)) {
    return { ok: false, error: "That encryption key does not match." };
  }
  await establishVaultUnlock({
    vaultKeyId: vault.id,
    crk: material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  return { ok: true };
}

export async function rotateVault(formData: FormData): Promise<ActionResult> {
  const owner = await ownerForSession();
  if ("error" in owner) return { ok: false, error: owner.error };
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) return { ok: false, error: "Create an encryption key first." };
  const current = readUnlockKey(formData, vault);
  if (!current.ok) return current;
  const replacement = readEnrollmentKey(formData);
  if (!replacement.ok) return replacement;
  try {
    const result = await rotateVaultKey({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      oldCrk: current.crk,
      newCrk: replacement.material.crk,
      kdf: replacement.material.kdf,
      kdfSalt: replacement.material.kdfSalt,
      kdfParams: replacement.material.kdfParams,
    });
    if (!result.completed) return { ok: true, id: "resume" };
  } catch {
    return { ok: false, error: "The encryption key could not be rotated." };
  }
  const active = await activeVault(owner.ownerType, owner.ownerId);
  if (!active) return { ok: false, error: "The encryption key could not be rotated." };
  await establishVaultUnlock({
    vaultKeyId: active.id,
    crk: replacement.material.crk,
    sessionId: owner.session.session.id,
    expiresAt: owner.session.session.expiresAt,
  });
  return { ok: true };
}

export async function vaultStatus(ownerType: string, ownerId: string) {
  const vault = await activeVault(ownerType, ownerId);
  return vault;
}

