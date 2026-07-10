import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { apiKeys, memberships, organisations, user } from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { requireOrgUser, AuthError, type OrgContext } from "@/lib/guards";
import { can, type Permission } from "@/lib/rbac";

export const API_KEY_PREFIX = "rv_";

/**
 * Resolve the org context for a REST/MCP request. Accepts either an
 * `Authorization: Bearer rv_...` API key or a browser session, and returns the
 * same OrgContext as requireOrgUser so route handlers reuse the RBAC layer.
 * The key inherits its creator's org and role.
 */
export async function resolveOrgContext(
  req: NextRequest,
  permission?: Permission,
): Promise<OrgContext> {
  const auth = req.headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (bearer?.startsWith(API_KEY_PREFIX)) {
    const ctx = await contextFromApiKey(bearer);
    if (permission && !can(ctx.role, permission)) {
      throw new AuthError(`Your role does not allow this action (${permission}).`);
    }
    return ctx;
  }

  // No API key: fall back to the session-based guard (throws AuthError).
  return requireOrgUser(permission);
}

async function contextFromApiKey(token: string): Promise<OrgContext> {
  const keyHash = sha256(token);
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      orgId: apiKeys.orgId,
      userId: apiKeys.userId,
      role: memberships.role,
      orgSlug: organisations.slug,
      orgName: organisations.name,
      userEmail: user.email,
      userName: user.name,
    })
    .from(apiKeys)
    .innerJoin(
      memberships,
      and(eq(memberships.userId, apiKeys.userId), eq(memberships.orgId, apiKeys.orgId)),
    )
    .innerJoin(organisations, eq(organisations.id, apiKeys.orgId))
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));

  if (!row) throw new AuthError("Invalid or revoked API key.");

  // Best-effort last-used stamp; never block the request on it.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.keyId))
    .catch(() => {});

  return {
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName,
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    role: row.role,
  };
}
