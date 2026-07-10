"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireOrgUser, requestMeta } from "@/lib/guards";
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

  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, ctx.orgId)))
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
