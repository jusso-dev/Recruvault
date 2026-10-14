import { randomBytes } from "crypto";
import { Client } from "pg";

/**
 * Isolated PostgreSQL for integration tests.
 *
 * With INTEGRATION_DATABASE_URL (an admin connection to a disposable server,
 * never production) each suite creates and later drops its own `rv_it_*`
 * database. Otherwise a Testcontainers Postgres is started, which needs Docker.
 * A suite that cannot get a database fails; it is never skipped.
 */
export type TestDatabase = { url: string; stop: () => Promise<void> };

export async function startTestDatabase(): Promise<TestDatabase> {
  const admin = process.env.INTEGRATION_DATABASE_URL;
  if (admin) {
    const name = `rv_it_${randomBytes(6).toString("hex")}`;
    const client = new Client({ connectionString: admin });
    await client.connect();
    await client.query(`CREATE DATABASE ${name}`);
    await client.end();
    const url = new URL(admin);
    url.pathname = `/${name}`;
    return {
      url: url.toString(),
      stop: async () => {
        const c = new Client({ connectionString: admin });
        await c.connect();
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await c.end();
      },
    };
  }
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

/** Binds @/db to a fresh migrated database. Call before importing modules that use @/db. */
export async function setupMigratedDatabase() {
  const database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: "drizzle" });
  return {
    db,
    stop: async () => {
      // Close the pool first so shutdown does not surface 57P01 errors.
      await (db.$client as { end: () => Promise<void> }).end();
      await database.stop();
    },
  };
}
