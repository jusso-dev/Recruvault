import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";

export default async function globalSetup() {
  loadEnvConfig(process.cwd());
  assertDisposableDatabase(process.env.DATABASE_URL);

  // CI provides PostgreSQL and the object store as job services.
  if (process.env.E2E_SKIP_SERVICES !== "1") {
    execFileSync("docker", ["compose", "up", "db", "minio", "minio-init", "-d"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }
  for (const script of ["db:migrate", "db:seed"]) {
    execFileSync("npm", ["run", script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }

  mkdirSync(".playwright/auth", { recursive: true });
  rmSync(".playwright/outbox", { recursive: true, force: true });
  mkdirSync(".playwright/outbox", { recursive: true });
  // Playwright overwrites its own named screenshots. Keep manually captured
  // MCP/client screenshots that cannot be reproduced by the browser suite.
  mkdirSync("docs/screenshots", { recursive: true });

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Authentication and secure-link limits are ephemeral operational state.
    // Reset them so repeated local E2E runs do not inherit a previous run's
    // localhost request budget.
    await client.query("delete from rate_limit");
    await client.query("delete from link_rate_limits");

    const e2eOrgIds = `
      select distinct m.org_id
      from memberships m
      join "user" u on u.id = m.user_id
      where u.email like '%@e2e.recruvault.test'
    `;
    await client.query(
      `delete from audit_chain_checkpoints where chain_scope in (
        select org_id::text from (${e2eOrgIds}) e2e_organisations
      )`,
    );
    await client.query(`
      delete from submission_documents
      where submission_id in (
        select s.id
        from submissions s
        join requests r on r.id = s.request_id
        where r.org_id in (${e2eOrgIds})
      )
    `);
    await client.query(`delete from wallet_shares where org_id in (${e2eOrgIds})`);
    await client.query(`delete from audit_events where org_id in (${e2eOrgIds})`);
    await client.query(`
      delete from organisations
      where id in (${e2eOrgIds})
    `);
    await client.query(`delete from "user" where email like '%@e2e.recruvault.test'`);
    await client.query(`delete from organisations where slug = 'e2e-platform-bootstrap'`);
  } finally {
    await client.end();
  }
}

/**
 * Cleanup below deletes rows. Refuse anything but a local database unless the
 * operator explicitly marks a remote one as disposable.
 */
function assertDisposableDatabase(url: string | undefined) {
  if (!url) throw new Error("DATABASE_URL is required for browser tests.");
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]", "db"].includes(host);
  if (!local && process.env.E2E_ALLOW_REMOTE_DB !== "1") {
    throw new Error("Refusing to run browser-test cleanup against a non-local DATABASE_URL.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run browser tests with NODE_ENV=production.");
  }
}
