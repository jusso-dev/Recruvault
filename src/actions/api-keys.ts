"use server";

import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { apiKeys, candidateApiKeys } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getSession, requireCandidate, requireOrgUser, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { generateOpaqueToken, sha256 } from "@/lib/crypto";
import { API_KEY_PREFIX } from "@/lib/api-auth";
import {
  CANDIDATE_API_SCOPES,
  DEFAULT_KEY_TTL_DAYS,
  keyExpiry,
  ORG_API_SCOPES,
  parseRequestedScopes,
  recentAuthentication,
  type ApiScope,
} from "@/lib/api-scopes";
import { insertCandidateApiKey, insertOrgApiKey, type NewKeyMaterial } from "@/lib/api-key-store";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { wrapForCredential } from "@/lib/vault-crypto";
import type { ActionResult } from "./org";

/**
 * Mint an API key for the caller's organisation. The plaintext is returned
 * once and never stored (only its SHA-256 hash and a display prefix are kept).
 * The key carries only the scopes explicitly selected, and every request is
 * still held to the creator's live role.
 */
export async function createApiKey(
  formData: FormData,
): Promise<ActionResult & { key?: string }> {
  const ctx = await requireOrgUser("api:manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the key a name." };
  const issued = await issueKeyMaterial(
    formData,
    formData.getAll("scopes").map(String),
    ORG_API_SCOPES,
    "organisation",
    ctx.orgId,
    ctx.userId,
  );
  if (!issued.ok) return issued;

  const inserted = await insertOrgApiKey({ orgId: ctx.orgId, userId: ctx.userId }, { name, ...issued.material });
  if (!inserted.ok) return inserted;

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "api_key.created",
    targetType: "api_key",
    targetId: inserted.id,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/integrations");
  return { ok: true, id: inserted.id, key: issued.key };
}

/**
 * Replace one of the caller's own keys: same name and scopes, a new secret and
 * expiry. The old key is revoked in the same transaction.
 */
export async function rotateApiKey(
  formData: FormData,
): Promise<ActionResult & { key?: string }> {
  const ctx = await requireOrgUser("api:manage");
  const keyId = String(formData.get("keyId") ?? "");
  const [old] = await db
    .select({ name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.orgId, ctx.orgId),
        eq(apiKeys.userId, ctx.userId),
        isNull(apiKeys.revokedAt),
      ),
    );
  if (!old) return { ok: false, error: "Key not found." };
  const issued = await issueKeyMaterial(formData, old.scopes, ORG_API_SCOPES, "organisation", ctx.orgId, ctx.userId);
  if (!issued.ok) return issued;

  const inserted = await insertOrgApiKey(
    { orgId: ctx.orgId, userId: ctx.userId },
    { name: old.name, ...issued.material },
    keyId,
  );
  if (!inserted.ok) return inserted;

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "api_key.rotated",
    targetType: "api_key",
    targetId: inserted.id,
    ...meta,
  });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/integrations");
  return { ok: true, id: inserted.id, key: issued.key };
}

/** Revoke an API key (tenant-scoped). */
export async function revokeApiKey(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("api:manage");
  const keyId = String(formData.get("keyId") ?? "");
  if (!keyId) return { ok: false, error: "Missing key id." };

  const ownership =
    ctx.role === "owner" || ctx.role === "admin"
      ? and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, ctx.orgId))
      : and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.orgId, ctx.orgId),
          eq(apiKeys.userId, ctx.userId),
        );
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(ownership)
    .returning({ id: apiKeys.id });
  if (!revoked) return { ok: false, error: "Key not found." };

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: keyId,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

/** Mint a key scoped strictly to the signed-in job seeker's own account. */
export async function createCandidateApiKey(
  formData: FormData,
): Promise<ActionResult & { key?: string }> {
  const ctx = await requireCandidate();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the key a name." };
  const issued = await issueKeyMaterial(
    formData,
    formData.getAll("scopes").map(String),
    CANDIDATE_API_SCOPES,
    "candidate",
    ctx.candidateAccountId,
    ctx.userId,
  );
  if (!issued.ok) return issued;

  const inserted = await insertCandidateApiKey(ctx.candidateAccountId, { name, ...issued.material });
  if (!inserted.ok) return inserted;

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "candidate_api_key.created",
    targetType: "candidate_api_key",
    targetId: inserted.id,
    ...meta,
  });
  revalidatePath("/integrations");
  return { ok: true, id: inserted.id, key: issued.key };
}

/** Replace one of the job seeker's own keys, revoking the old one atomically. */
export async function rotateCandidateApiKey(
  formData: FormData,
): Promise<ActionResult & { key?: string }> {
  const ctx = await requireCandidate();
  const keyId = String(formData.get("keyId") ?? "");
  const [old] = await db
    .select({ name: candidateApiKeys.name, scopes: candidateApiKeys.scopes })
    .from(candidateApiKeys)
    .where(
      and(
        eq(candidateApiKeys.id, keyId),
        eq(candidateApiKeys.candidateAccountId, ctx.candidateAccountId),
        isNull(candidateApiKeys.revokedAt),
      ),
    );
  if (!old) return { ok: false, error: "Key not found." };
  const issued = await issueKeyMaterial(
    formData,
    old.scopes,
    CANDIDATE_API_SCOPES,
    "candidate",
    ctx.candidateAccountId,
    ctx.userId,
  );
  if (!issued.ok) return issued;

  const inserted = await insertCandidateApiKey(
    ctx.candidateAccountId,
    { name: old.name, ...issued.material },
    keyId,
  );
  if (!inserted.ok) return inserted;

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "candidate_api_key.rotated",
    targetType: "candidate_api_key",
    targetId: inserted.id,
    ...meta,
  });
  revalidatePath("/integrations");
  return { ok: true, id: inserted.id, key: issued.key };
}

/**
 * Recent authentication: the session must be under 15 minutes old, or the
 * caller re-enters their password. Passwordless accounts sign in again.
 */
async function confirmRecentAuth(formData: FormData, userId: string): Promise<string | null> {
  const authSession = await getSession();
  if (!authSession || authSession.user.id !== userId) return "Sign in again before managing API keys.";
  if (recentAuthentication(authSession.session.createdAt)) return null;
  const password = String(formData.get("password") ?? "");
  if (!password) return "Enter your password, or sign in again, before managing API keys.";
  try {
    await auth.api.verifyPassword({ body: { password }, headers: await headers() });
    return null;
  } catch {
    return "That password is not correct.";
  }
}

async function issueKeyMaterial(
  formData: FormData,
  requested: string[],
  allowed: readonly ApiScope[],
  ownerType: "organisation" | "candidate",
  ownerId: string,
  userId: string,
): Promise<
  | { ok: true; key: string; material: Omit<NewKeyMaterial, "name"> }
  | { ok: false; error: string }
> {
  // No implicit default: an empty selection is rejected, and legacy:full
  // keys cannot be re-issued or rotated into a new key.
  const scopes = parseRequestedScopes(requested, allowed);
  if (!scopes.ok) return scopes;
  const expiresAt = keyExpiry(Number(formData.get("ttlDays") ?? DEFAULT_KEY_TTL_DAYS));
  if (!expiresAt) return { ok: false, error: "Choose an expiry between 1 and 365 days." };

  const authError = await confirmRecentAuth(formData, userId);
  if (authError) return { ok: false, error: authError };
  const crk = await readUnlockedCustomerKey(ownerType, ownerId);
  const vault = await activeVault(ownerType, ownerId);
  if (!crk || !vault) return { ok: false, error: "Unlock the encryption key before creating an API key." };

  const { token } = generateOpaqueToken();
  const key = `${API_KEY_PREFIX}${token}`;
  return {
    ok: true,
    key,
    material: {
      keyHash: sha256(key),
      prefix: key.slice(0, 11),
      scopes: scopes.scopes,
      expiresAt,
      vaultKeyId: vault.id,
      wrappedVaultKey: wrapForCredential(key, crk),
    },
  };
}

/** Revoke one of the signed-in job seeker's own keys. */
export async function revokeCandidateApiKey(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const keyId = String(formData.get("keyId") ?? "");
  if (!keyId) return { ok: false, error: "Missing key id." };

  const [revoked] = await db
    .update(candidateApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(candidateApiKeys.id, keyId),
        eq(candidateApiKeys.candidateAccountId, ctx.candidateAccountId),
      ),
    )
    .returning({ id: candidateApiKeys.id });
  if (!revoked) return { ok: false, error: "Key not found." };

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "candidate_api_key.revoked",
    targetType: "candidate_api_key",
    targetId: keyId,
    ...meta,
  });
  revalidatePath("/integrations");
  return { ok: true };
}
