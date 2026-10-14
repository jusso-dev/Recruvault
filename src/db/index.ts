import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pool?: Pool };

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://recruvault:recruvault@localhost:5432/recruvault",
    max: 10,
    // Columns are `timestamp` without time zone. Pin the session to UTC so
    // DB `now()` defaults compare correctly with JS dates on any server zone.
    options: "-c TimeZone=UTC",
  });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
export { schema };
