import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";

export default async function globalSetup() {
  loadEnvConfig(process.cwd());

  execFileSync("docker", ["compose", "up", "db", "minio", "minio-init", "-d"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  mkdirSync(".playwright/auth", { recursive: true });
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

    // A brand-new installation correctly routes to /setup. The remaining
    // browser tests exercise ordinary account registration, so initialize
    // only a completely empty E2E database before those flows begin.
    await client.query(`
      insert into organisations (name, slug)
      select 'E2E Platform Bootstrap', 'e2e-platform-bootstrap'
      where not exists (select 1 from organisations)
      on conflict (slug) do nothing
    `);
  } finally {
    await client.end();
  }
}
