import { sql } from "drizzle-orm";
import { db } from "@/db";
import { outboxNeedsAttention, outboxStats } from "@/lib/outbox";
import { storageReady } from "@/lib/storage";
import { scannerReady } from "@/lib/scan";

async function databaseReady(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Jobs run in Inngest, so a stopped or unreachable Inngest cannot report
 * itself. The outbox can: events stop draining and age past the same
 * threshold the outbox-maintenance cron warns on.
 */
async function jobsState(): Promise<"ok" | "backlog" | "unavailable"> {
  try {
    return outboxNeedsAttention(await outboxStats()) ? "backlog" : "ok";
  } catch {
    return "unavailable";
  }
}

/**
 * Readiness. The database and object store are required (503 without them).
 * A scanner outage or a job backlog is reported as degraded: uploads are
 * refused until the scanner answers, and queued delivery, scanning, and
 * retention work waits until jobs drain, but reads and the rest of the app
 * keep working.
 */
export async function GET() {
  const [database, storage, scanner, jobs] = await Promise.all([
    databaseReady(),
    storageReady(),
    scannerReady(),
    jobsState(),
  ]);
  const ready = database && storage;
  const status = !ready ? "unavailable" : scanner && jobs === "ok" ? "ok" : "degraded";
  return Response.json(
    {
      status,
      check: "readiness",
      database: database ? "ok" : "unavailable",
      storage: storage ? "ok" : "unavailable",
      scanner: scanner ? "ok" : "unavailable",
      jobs,
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
