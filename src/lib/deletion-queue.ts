import "server-only";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { deletionTasks } from "@/db/schema";
import { deleteObject } from "@/lib/storage";
import { sanitizeForTelemetry } from "@/lib/redact";
import { getLogger } from "@/lib/logger";

const log = getLogger("deletion");
const MAX_ATTEMPTS = 8;

type Executor = Pick<typeof db, "insert">;
type DeleteFn = (storageKey: string) => Promise<void>;

export async function enqueueDeletion(
  executor: Executor,
  storageKey: string,
  ownerScope?: string | null,
) {
  await executor.insert(deletionTasks).values({
    storageKey,
    ownerScope: ownerScope ?? null,
    state: "pending",
  });
}

function missingObject(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NoSuchKey|NotFound|404|NoSuchBucket/i.test(message);
}

/** Retry object deletion until it succeeds or reaches the dead-letter state. */
export async function processDeletionTasks(remove: DeleteFn = deleteObject, limit = 50): Promise<number> {
  const due = await db
    .select()
    .from(deletionTasks)
    .where(and(eq(deletionTasks.state, "pending"), lte(deletionTasks.availableAt, new Date())))
    .orderBy(deletionTasks.createdAt)
    .limit(limit);

  let finished = 0;
  for (const task of due) {
    try {
      await remove(task.storageKey);
      await db
        .update(deletionTasks)
        .set({ state: "done", completedAt: new Date(), lastError: null })
        .where(and(eq(deletionTasks.id, task.id), eq(deletionTasks.state, "pending")));
      finished += 1;
    } catch (error) {
      if (missingObject(error)) {
        await db
          .update(deletionTasks)
          .set({ state: "done", completedAt: new Date(), lastError: null })
          .where(eq(deletionTasks.id, task.id));
        finished += 1;
        continue;
      }
      const attempts = task.attempts + 1;
      const message = String(sanitizeForTelemetry(error instanceof Error ? error.message : "delete failed")).slice(0, 240);
      log.error({ taskId: task.id, attempts }, "object deletion will retry");
      await db
        .update(deletionTasks)
        .set({
          attempts,
          state: attempts >= MAX_ATTEMPTS ? "dead" : "pending",
          lastError: message,
          availableAt: new Date(Date.now() + Math.min(300, 2 ** attempts) * 1000),
        })
        .where(eq(deletionTasks.id, task.id));
    }
  }
  return finished;
}
