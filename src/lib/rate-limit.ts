import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { linkRateLimits } from "@/db/schema";

/**
 * DB-backed fixed-window rate limiter for the link/OTP endpoints. Works across
 * app instances (unlike an in-memory counter). Defense-in-depth on top of the
 * per-token OTP counters — the primary control remains the token-scoped caps.
 *
 * The IP comes from `x-forwarded-for`, which is proxy-controlled, so treat this
 * as best-effort throttling, not authentication.
 *
 * @returns true when the request is allowed, false when the limit is exceeded.
 */
export async function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
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
    .returning({ count: linkRateLimits.count });

  return (row?.count ?? 1) <= max;
}
