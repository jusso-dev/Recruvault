"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { apiKeys, candidateApiKeys } from "@/db/schema";
import { requireCandidate, requireOrgUser, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { generateOpaqueToken, sha256 } from "@/lib/crypto";
import { API_KEY_PREFIX } from "@/lib/api-auth";
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

  const { token } = generateOpaqueToken();
  const key = `${API_KEY_PREFIX}${token}`;
  const prefix = key.slice(0, 11);

  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: ctx.orgId,
      userId: ctx.userId,
      name,
      keyHash: sha256(key),
      prefix,
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
  return { ok: true, id: row.id, key };
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

  const { token } = generateOpaqueToken();
  const key = `${API_KEY_PREFIX}${token}`;
  const prefix = key.slice(0, 11);
  const [row] = await db
    .insert(candidateApiKeys)
    .values({
      candidateAccountId: ctx.candidateAccountId,
      name,
      keyHash: sha256(key),
      prefix,
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
  return { ok: true, id: row.id, key };
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
