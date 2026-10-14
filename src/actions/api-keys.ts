"use server";

import { and, eq, isNull, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { apiKeys, candidateApiKeys } from "@/db/schema";
import { getSession, requireCandidate, requireOrgUser, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { generateOpaqueToken, sha256 } from "@/lib/crypto";
import { API_KEY_PREFIX } from "@/lib/api-auth";
import {
  CANDIDATE_API_SCOPES,
  DEFAULT_KEY_TTL_DAYS,
  keyExpiry,
  MAX_ACTIVE_KEYS,
  ORG_API_SCOPES,
  parseRequestedScopes,
  recentAuthentication,
  type ApiScope,
} from "@/lib/api-scopes";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { wrapForCredential } from "@/lib/vault-crypto";
import type { ActionResult } from "./org";

/**
 * Mint an API key for the caller's organisation. The plaintext is returned
 * once and never stored (only its SHA-256 hash and a display prefix are kept).
 * The key inherits the creator's role.
 */
export async function createApiKey(
  formData: FormData,
): Promise<ActionResult & { key?: string }> {
  const ctx = await requireOrgUser("api:manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the key a name." };
  const issued = await issueKeyMaterial(formData, ORG_API_SCOPES, "organisation", ctx.orgId, ctx.userId);
  if (!issued.ok) return issued;

  const active = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, ctx.userId), eq(apiKeys.orgId, ctx.orgId), isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, new Date())));
  if (active.length >= MAX_ACTIVE_KEYS) return { ok: false, error: "Revoke an existing key before creating another." };

  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: ctx.orgId,
      userId: ctx.userId,
      name,
      keyHash: sha256(issued.key),
      prefix: issued.key.slice(0, 11),
      scopes: issued.scopes,
      expiresAt: issued.expiresAt,
      vaultKeyId: issued.vaultKeyId,
      wrappedVaultKey: issued.wrappedVaultKey,
    })
    .returning({ id: apiKeys.id });

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "api_key.created",
    targetType: "api_key",
    targetId: row.id,
    ...meta,
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/integrations");
  return { ok: true, id: row.id, key: issued.key };
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
  const issued = await issueKeyMaterial(formData, CANDIDATE_API_SCOPES, "candidate", ctx.candidateAccountId, ctx.userId);
  if (!issued.ok) return issued;

  const active = await db
    .select({ id: candidateApiKeys.id })
    .from(candidateApiKeys)
    .where(
      and(
        eq(candidateApiKeys.candidateAccountId, ctx.candidateAccountId),
        isNull(candidateApiKeys.revokedAt),
        gt(candidateApiKeys.expiresAt, new Date()),
      ),
    );
  if (active.length >= MAX_ACTIVE_KEYS) return { ok: false, error: "Revoke an existing key before creating another." };

  const [row] = await db
    .insert(candidateApiKeys)
    .values({
      candidateAccountId: ctx.candidateAccountId,
      name,
      keyHash: sha256(issued.key),
      prefix: issued.key.slice(0, 11),
      scopes: issued.scopes,
      expiresAt: issued.expiresAt,
      vaultKeyId: issued.vaultKeyId,
      wrappedVaultKey: issued.wrappedVaultKey,
    })
    .returning({ id: candidateApiKeys.id });

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "candidate_api_key.created",
    targetType: "candidate_api_key",
    targetId: row.id,
    ...meta,
  });
  revalidatePath("/integrations");
  return { ok: true, id: row.id, key: issued.key };
}

async function issueKeyMaterial(
  formData: FormData,
  allowed: readonly ApiScope[],
  ownerType: "organisation" | "candidate",
  ownerId: string,
  userId: string,
): Promise<
  | {
      ok: true;
      key: string;
      scopes: string[];
      expiresAt: Date;
      vaultKeyId: string;
      wrappedVaultKey: string;
    }
  | { ok: false; error: string }
> {
  const requested = formData.getAll("scopes").map(String);
  const scopes = parseRequestedScopes(
    requested.length > 0 ? requested : [...allowed],
    allowed,
  );
  if (!scopes.ok) return scopes;
  const expiresAt = keyExpiry(Number(formData.get("ttlDays") ?? DEFAULT_KEY_TTL_DAYS));
  if (!expiresAt) return { ok: false, error: "Choose an expiry between 1 and 365 days." };

  const authSession = await getSession();
  if (!authSession || authSession.user.id !== userId || !recentAuthentication(authSession.session.createdAt)) {
    return { ok: false, error: "Sign in again before creating an API key." };
  }
  const crk = await readUnlockedCustomerKey(ownerType, ownerId);
  const vault = await activeVault(ownerType, ownerId);
  if (!crk || !vault) return { ok: false, error: "Unlock the encryption key before creating an API key." };

  const { token } = generateOpaqueToken();
  const key = `${API_KEY_PREFIX}${token}`;
  return {
    ok: true,
    key,
    scopes: scopes.scopes,
    expiresAt,
    vaultKeyId: vault.id,
    wrappedVaultKey: wrapForCredential(key, crk),
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
