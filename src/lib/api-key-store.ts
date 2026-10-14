import "server-only";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, candidateApiKeys } from "@/db/schema";
import { MAX_ACTIVE_KEYS, MAX_ORG_ACTIVE_KEYS } from "@/lib/api-scopes";

/**
 * Key inserts with bounded counts. The count and the insert run in one
 * transaction under an advisory lock per owner, so concurrent requests cannot
 * both pass the cap. Rotation inserts the replacement and revokes the old key
 * in the same transaction.
 */

export interface NewKeyMaterial {
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date;
  vaultKeyId: string;
  wrappedVaultKey: string;
}

type Result = { ok: true; id: string } | { ok: false; error: string };

const CAP_ERROR = "Revoke an existing key before creating another.";
const ORG_CAP_ERROR = "This organisation has reached its active API key limit. Revoke unused keys first.";
const ROTATE_MISSING = "Key not found or already revoked.";

export async function insertOrgApiKey(
  owner: { orgId: string; userId: string },
  key: NewKeyMaterial,
  rotateFromId?: string,
): Promise<Result> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`api-keys:org:${owner.orgId}`}))`);
    const active = and(
      eq(apiKeys.orgId, owner.orgId),
      isNull(apiKeys.revokedAt),
      gt(apiKeys.expiresAt, new Date()),
      rotateFromId ? ne(apiKeys.id, rotateFromId) : undefined,
    );
    const [counts] = await tx
      .select({
        org: sql<number>`count(*)::int`,
        user: sql<number>`count(*) filter (where ${apiKeys.userId} = ${owner.userId})::int`,
      })
      .from(apiKeys)
      .where(active);
    if ((counts?.user ?? 0) >= MAX_ACTIVE_KEYS) return { ok: false, error: CAP_ERROR };
    if ((counts?.org ?? 0) >= MAX_ORG_ACTIVE_KEYS) return { ok: false, error: ORG_CAP_ERROR };

    if (rotateFromId) {
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, rotateFromId),
            eq(apiKeys.orgId, owner.orgId),
            eq(apiKeys.userId, owner.userId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });
      if (!revoked) return { ok: false, error: ROTATE_MISSING };
    }

    const [row] = await tx
      .insert(apiKeys)
      .values({ orgId: owner.orgId, userId: owner.userId, ...key })
      .returning({ id: apiKeys.id });
    return { ok: true, id: row.id };
  });
}

export async function insertCandidateApiKey(
  candidateAccountId: string,
  key: NewKeyMaterial,
  rotateFromId?: string,
): Promise<Result> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`api-keys:candidate:${candidateAccountId}`}))`);
    const [counts] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(candidateApiKeys)
      .where(
        and(
          eq(candidateApiKeys.candidateAccountId, candidateAccountId),
          isNull(candidateApiKeys.revokedAt),
          gt(candidateApiKeys.expiresAt, new Date()),
          rotateFromId ? ne(candidateApiKeys.id, rotateFromId) : undefined,
        ),
      );
    if ((counts?.active ?? 0) >= MAX_ACTIVE_KEYS) return { ok: false, error: CAP_ERROR };

    if (rotateFromId) {
      const [revoked] = await tx
        .update(candidateApiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(candidateApiKeys.id, rotateFromId),
            eq(candidateApiKeys.candidateAccountId, candidateAccountId),
            isNull(candidateApiKeys.revokedAt),
          ),
        )
        .returning({ id: candidateApiKeys.id });
      if (!revoked) return { ok: false, error: ROTATE_MISSING };
    }

    const [row] = await tx
      .insert(candidateApiKeys)
      .values({ candidateAccountId, ...key })
      .returning({ id: candidateApiKeys.id });
    return { ok: true, id: row.id };
  });
}
