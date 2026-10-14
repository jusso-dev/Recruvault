import { eq, isNotNull, and } from "drizzle-orm";
import { db } from "@/db";
import { memberships, platformBootstrap } from "@/db/schema";

/** Advisory lock shared by every first-owner bootstrap attempt. */
export const BOOTSTRAP_LOCK = 814726391;

// Completion never reverts, so once observed it can be cached per process.
let completed = false;

/**
 * The consumed platform_bootstrap row is the only source of truth for "setup
 * is done". Installs that predate the row and already have an owner are
 * backfilled once; since only completed setup can create an owner while the
 * row is missing, this cannot reopen a public claim.
 */
export async function isPlatformBootstrapped(): Promise<boolean> {
  if (completed) return true;
  const [row] = await db
    .select({ id: platformBootstrap.id })
    .from(platformBootstrap)
    .where(and(eq(platformBootstrap.id, "platform"), isNotNull(platformBootstrap.consumedAt)));
  if (row) {
    completed = true;
    return true;
  }
  const [owner] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.role, "owner"))
    .limit(1);
  if (!owner) return false;
  await db
    .insert(platformBootstrap)
    .values({ id: "platform", tokenHash: "pre-bootstrap-install", consumedAt: new Date(), consumedByUserId: owner.userId })
    .onConflictDoUpdate({ target: platformBootstrap.id, set: { consumedAt: new Date() } });
  completed = true;
  return true;
}

/** Test hook: forget the cached completion state. */
export function resetBootstrapCache() {
  completed = false;
}
