import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { deletionTasks, erasureRecords } from "@/db/schema";
import { deleteObject, isMissingObjectError } from "@/lib/storage";
import { sanitizeForTelemetry } from "@/lib/redact";
import { getLogger } from "@/lib/logger";

const log = getLogger("deletion");
export const MAX_DELETION_ATTEMPTS = 8;
// A claimed task is invisible to other workers for this long. A worker that
// dies mid-task releases it when the lease runs out.
const LEASE_MS = 5 * 60 * 1000;
// Pending this long, or retried this often, counts as stuck for the reconciler.
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
const STUCK_ATTEMPTS = 3;

type Executor = Pick<typeof db, "insert">;
type DeleteFn = (storageKey: string) => Promise<void>;

export async function enqueueDeletion(
  executor: Executor,
  storageKey: string,
  ownerScope?: string | null,
  erasureId?: string | null,
) {
  await executor.insert(deletionTasks).values({
    storageKey,
    ownerScope: ownerScope ?? null,
    erasureId: erasureId ?? null,
    state: "pending",
    // Written from the app clock, like every later availableAt, so the due
    // check compares like with like (the column default has microseconds).
    availableAt: new Date(),
  });
}

async function claimDue(limit: number, erasureId?: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(deletionTasks)
      .where(
        and(
          eq(deletionTasks.state, "pending"),
          lte(deletionTasks.availableAt, new Date()),
          erasureId ? eq(deletionTasks.erasureId, erasureId) : undefined,
        ),
      )
      .orderBy(deletionTasks.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(deletionTasks)
        .set({ availableAt: new Date(Date.now() + LEASE_MS) })
        .where(inArray(deletionTasks.id, rows.map((r) => r.id)));
    }
    return rows;
  });
}

/**
 * Retry object deletion until it succeeds or reaches the dead-letter state.
 * Tasks are claimed with SKIP LOCKED so concurrent workers never share one, and
 * an object that is already gone counts as deleted.
 */
export async function processDeletionTasks(
  remove: DeleteFn = deleteObject,
  limit = 50,
  opts: { erasureId?: string } = {},
): Promise<number> {
  const due = await claimDue(limit, opts.erasureId);

  let finished = 0;
  for (const task of due) {
    try {
      await remove(task.storageKey);
    } catch (error) {
      if (!isMissingObjectError(error)) {
        const attempts = task.attempts + 1;
        const dead = attempts >= MAX_DELETION_ATTEMPTS;
        const message = String(
          sanitizeForTelemetry(error instanceof Error ? error.message : "delete failed"),
        ).slice(0, 240);
        if (dead) log.error({ taskId: task.id, attempts }, "object deletion dead-lettered");
        else log.warn({ taskId: task.id, attempts }, "object deletion will retry");
        await db
          .update(deletionTasks)
          .set({
            attempts,
            state: dead ? "dead" : "pending",
            lastError: message,
            availableAt: new Date(Date.now() + Math.min(300, 2 ** attempts) * 1000),
          })
          .where(eq(deletionTasks.id, task.id));
        continue;
      }
    }
    await db
      .update(deletionTasks)
      .set({ state: "done", completedAt: new Date(), lastError: null })
      .where(and(eq(deletionTasks.id, task.id), eq(deletionTasks.state, "pending")));
    finished += 1;
  }
  if (finished > 0) await completeFinishedErasures();
  return finished;
}

/**
 * Manual retry for dead-lettered tasks (all, or the given ids). Safe to repeat:
 * deleting an absent object succeeds.
 */
export async function retryDeadDeletionTasks(ids?: string[]): Promise<number> {
  const rows = await db
    .update(deletionTasks)
    .set({ state: "pending", attempts: 0, availableAt: new Date(), lastError: null })
    .where(
      and(
        eq(deletionTasks.state, "dead"),
        ids && ids.length > 0 ? inArray(deletionTasks.id, ids) : undefined,
      ),
    )
    .returning({ id: deletionTasks.id });
  if (rows.length > 0) log.info({ count: rows.length }, "dead deletion tasks requeued");
  return rows.length;
}

/** Counts only, for alerting and the reconciler report. */
export async function deletionQueueStats(): Promise<{
  pending: number;
  dead: number;
  stuck: number;
}> {
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${deletionTasks.state} = 'pending')::int`,
      dead: sql<number>`count(*) filter (where ${deletionTasks.state} = 'dead')::int`,
      stuck: sql<number>`count(*) filter (where ${deletionTasks.state} = 'pending' and (${deletionTasks.attempts} >= ${STUCK_ATTEMPTS} or ${deletionTasks.createdAt} < ${stuckBefore}))::int`,
    })
    .from(deletionTasks);
  return { pending: row?.pending ?? 0, dead: row?.dead ?? 0, stuck: row?.stuck ?? 0 };
}

/** Move purge and erasure records to cleanup-finished once every linked task is done. */
export async function completeFinishedErasures(): Promise<number> {
  const rows = await db
    .update(erasureRecords)
    .set({ cleanupFinishedAt: new Date() })
    .where(
      and(
        isNotNull(erasureRecords.cleanupPendingAt),
        isNull(erasureRecords.cleanupFinishedAt),
        sql`not exists (select 1 from ${deletionTasks} where ${deletionTasks.erasureId} = ${erasureRecords.id} and ${deletionTasks.state} <> 'done')`,
      ),
    )
    .returning({ id: erasureRecords.id });
  return rows.length;
}
