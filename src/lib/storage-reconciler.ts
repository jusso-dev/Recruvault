import "server-only";
import { and, eq, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { deletionTasks, documentMigrations, documents, walletDocuments } from "@/db/schema";
import {
  completeFinishedErasures,
  deletionQueueStats,
  enqueueDeletion,
} from "@/lib/deletion-queue";
import { stuckMigrationCount } from "@/lib/document-migration";
import { getLogger } from "@/lib/logger";
import { listObjects } from "@/lib/storage";

/**
 * Compare the object store with the database. An object under a document
 * prefix that no row, in-flight migration, or open deletion task references
 * is an orphan (for example an upload whose database write never committed);
 * once it is older than the age threshold it is queued for deletion. Also
 * reports stuck and dead deletion tasks, and finishes erasure records whose
 * cleanup is complete. The report holds counts only.
 */

const log = getLogger("reconciler");
// Uploads write the object before the row commits; leave young objects alone.
const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const DONE_TASK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DOCUMENT_PREFIXES = ["org/", "wallet/"];

export type ReconcileReport = {
  objects: number;
  orphansQueued: number;
  pendingTasks: number;
  deadTasks: number;
  stuckTasks: number;
  stuckMigrations: number;
  erasuresFinished: number;
  doneTasksPruned: number;
};

type Lister = (prefix: string) => Promise<{ key: string; lastModified?: Date }[]>;

export async function reconcileStorage(
  opts: { orphanMinAgeMs?: number; list?: Lister } = {},
): Promise<ReconcileReport> {
  const list = opts.list ?? listObjects;
  const minAge = opts.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
  const objects = (await Promise.all(DOCUMENT_PREFIXES.map((p) => list(p)))).flat();

  const referenced = new Set<string>();
  for (const r of await db.select({ key: documents.storageKey }).from(documents)) referenced.add(r.key);
  for (const r of await db.select({ key: walletDocuments.storageKey }).from(walletDocuments)) {
    referenced.add(r.key);
  }
  for (const r of await db
    .select({ oldKey: documentMigrations.oldStorageKey, newKey: documentMigrations.newStorageKey })
    .from(documentMigrations)
    .where(eq(documentMigrations.state, "uploading"))) {
    referenced.add(r.oldKey);
    if (r.newKey) referenced.add(r.newKey);
  }
  for (const r of await db
    .select({ key: deletionTasks.storageKey })
    .from(deletionTasks)
    .where(ne(deletionTasks.state, "done"))) {
    referenced.add(r.key);
  }

  const now = Date.now();
  const orphans = objects.filter(
    (o) => !referenced.has(o.key) && (!o.lastModified || now - o.lastModified.getTime() >= minAge),
  );
  if (orphans.length > 0) {
    await db.transaction(async (tx) => {
      for (const o of orphans) await enqueueDeletion(tx, o.key, o.key.split("/")[1] ?? null);
    });
  }

  const pruned = await db
    .delete(deletionTasks)
    .where(
      and(
        eq(deletionTasks.state, "done"),
        lt(deletionTasks.completedAt, new Date(now - DONE_TASK_RETENTION_MS)),
      ),
    )
    .returning({ id: deletionTasks.id });

  const queue = await deletionQueueStats();
  const report: ReconcileReport = {
    objects: objects.length,
    orphansQueued: orphans.length,
    pendingTasks: queue.pending,
    deadTasks: queue.dead,
    stuckTasks: queue.stuck,
    stuckMigrations: await stuckMigrationCount(),
    erasuresFinished: await completeFinishedErasures(),
    doneTasksPruned: pruned.length,
  };
  if (report.deadTasks > 0 || report.stuckTasks > 0 || report.stuckMigrations > 0) {
    log.error(report, "storage cleanup needs attention");
  } else {
    log.info(report, "storage reconciled");
  }
  return report;
}
