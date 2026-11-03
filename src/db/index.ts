import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getLogger } from "@/lib/logger";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pool?: Pool };

function createPool() {
  const created = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://recruvault:recruvault@localhost:5432/recruvault",
    max: 10,
    // Fail a checkout instead of hanging when the database is unreachable.
    connectionTimeoutMillis: 5000,
    // Columns are `timestamp` without time zone. Pin the session to UTC so
    // DB `now()` defaults compare correctly with JS dates on any server zone.
    options: "-c TimeZone=UTC",
  });
  // An idle client dropped by the server (restart, network loss) emits here.
  // Without a listener it becomes an uncaught exception.
  const log = getLogger("db");
  created.on("error", (error) => log.error({ err: error }, "idle database client error"));
  return created;
}

const pool = globalForDb.pool ?? createPool();

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
export { schema };
