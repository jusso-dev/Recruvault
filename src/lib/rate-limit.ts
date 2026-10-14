import "server-only";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { linkRateLimits } from "@/db/schema";

/**
 * DB-backed fixed-window rate limiter for the link/OTP endpoints and the v1
 * API. Works across app instances (unlike an in-memory counter): the single
 * upsert is atomic, so concurrent requests on any instance share one count.
 * Defense-in-depth on top of the per-token OTP counters — the primary control
 * remains the token-scoped caps.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const windowSql = sql`(now() - (${windowMs} || ' milliseconds')::interval)`;
  const [row] = await db
    .insert(linkRateLimits)
    .values({ key, count: 1 })
    .onConflictDoUpdate({
      target: linkRateLimits.key,
      set: {
        count: sql`case when ${linkRateLimits.windowStart} < ${windowSql}
          then 1 else ${linkRateLimits.count} + 1 end`,
        windowStart: sql`case when ${linkRateLimits.windowStart} < ${windowSql}
          then now() else ${linkRateLimits.windowStart} end`,
      },
    })
    .returning({
      count: linkRateLimits.count,
      resetMs: sql<number>`(extract(epoch from (${linkRateLimits.windowStart}
        + (${windowMs} || ' milliseconds')::interval - now())) * 1000)::float8`,
    });

  const count = row?.count ?? 1;
  const resetMs = Math.max(0, Math.min(windowMs, Number(row?.resetMs ?? windowMs)));
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
  };
}

/** @returns true when the request is allowed, false when the limit is exceeded. */
export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  return (await consumeRateLimit(key, max, windowMs)).allowed;
}

/** Remove windows idle for a day. Every limiter here uses windows under a day. */
export async function pruneRateLimits(now = new Date()): Promise<number> {
  const rows = await db
    .delete(linkRateLimits)
    .where(lt(linkRateLimits.windowStart, new Date(now.getTime() - 86_400_000)))
    .returning({ key: linkRateLimits.key });
  return rows.length;
}
