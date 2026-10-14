import { sql } from "drizzle-orm";
import { db } from "@/db";
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
 * Readiness. The database and object store are required (503 without them).
 * A scanner outage is reported as degraded: uploads are refused until it
 * answers, but reads and the rest of the app keep working.
 */
export async function GET() {
  const [database, storage, scanner] = await Promise.all([
    databaseReady(),
    storageReady(),
    scannerReady(),
  ]);
  const ready = database && storage;
  const status = !ready ? "unavailable" : scanner ? "ok" : "degraded";
  return Response.json(
    {
      status,
      check: "readiness",
      database: database ? "ok" : "unavailable",
      storage: storage ? "ok" : "unavailable",
      scanner: scanner ? "ok" : "unavailable",
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
