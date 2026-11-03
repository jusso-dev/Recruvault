import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { Client, type QueryResultRow } from "pg";

loadEnvConfig(process.cwd());

/**
 * Database reads for the security matrix: resolving ids the UI would show,
 * forcing expiry on synthetic sessions, keys, and links, and confirming a
 * denied call changed nothing. Global setup has already refused any
 * non-disposable DATABASE_URL.
 */

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every principal signs in from 127.0.0.1, so per-IP auth budgets are reset between sign-ins. */
export async function resetRateLimits() {
  await query("delete from rate_limit");
  await query("delete from link_rate_limits");
}

export async function userId(email: string) {
  const [row] = await query<{ id: string }>(`select id from "user" where email = $1`, [email]);
  if (!row) throw new Error("No such user.");
  return row.id;
}

export async function membershipId(email: string) {
  const [row] = await query<{ id: string }>(
    `select m.id from memberships m join "user" u on u.id = m.user_id where u.email = $1`,
    [email],
  );
  if (!row) throw new Error("No membership.");
  return row.id;
}

export async function membershipRole(id: string) {
  const [row] = await query<{ role: string }>(`select role from memberships where id = $1`, [id]);
  return row?.role ?? null;
}

export async function organisationCount() {
  const [row] = await query<{ n: string }>(`select count(*)::text as n from organisations`);
  return Number(row.n);
}

export async function orgSettings(orgId: string) {
  const [row] = await query<{ retention_days: number; branding: unknown }>(
    `select retention_days, branding from organisations where id = $1`,
    [orgId],
  );
  return row;
}

export async function orgIdForEmail(email: string) {
  const [row] = await query<{ org_id: string }>(
    `select m.org_id from memberships m join "user" u on u.id = m.user_id where u.email = $1`,
    [email],
  );
  return row?.org_id ?? null;
}

export async function requestFields(requestId: string) {
  return query<{ id: string; key: string; type: string }>(
    `select id, key, type from request_fields where request_id = $1 order by sort_order`,
    [requestId],
  );
}

export async function requestRow(requestId: string) {
  const [row] = await query<{ status: string; title: string; jd_document_id: string | null }>(
    `select status, title, jd_document_id from requests where id = $1`,
    [requestId],
  );
  return row;
}

export async function requestCountForOrg(orgId: string) {
  const [row] = await query<{ n: string }>(`select count(*)::text as n from requests where org_id = $1`, [orgId]);
  return Number(row.n);
}

export async function deliveryCount(requestId: string) {
  const [row] = await query<{ n: string }>(`select count(*)::text as n from deliveries where request_id = $1`, [
    requestId,
  ]);
  return Number(row.n);
}

export async function templateId(orgId: string) {
  const [row] = await query<{ id: string }>(`select id from request_templates where org_id = $1 limit 1`, [orgId]);
  return row?.id ?? null;
}

export async function accessToken(rawToken: string) {
  const [row] = await query<{ id: string; revoked_at: Date | null; verified_at: Date | null; consumed_at: Date | null }>(
    `select id, revoked_at, verified_at, consumed_at from access_tokens where token_hash = $1`,
    [sha256(rawToken)],
  );
  if (!row) throw new Error("No such link.");
  return row;
}

// Timestamps are stored as UTC in columns without a zone, so "expired" writes
// use UTC explicitly; a non-UTC database server would otherwise shift them.
export async function expireAccessToken(rawToken: string) {
  await query(`update access_tokens set expires_at = (now() at time zone 'utc') - interval '1 hour' where token_hash = $1`, [
    sha256(rawToken),
  ]);
}

export async function submissionForToken(accessTokenId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [row] = await query<{ id: string; status: string; purged_at: Date | null }>(
      `select id, status, purged_at from submissions where access_token_id = $1 order by created_at desc limit 1`,
      [accessTokenId],
    );
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Submission was not created in time.");
}

export async function submissionRow(id: string) {
  const [row] = await query<{ status: string; purged_at: Date | null }>(
    `select status, purged_at from submissions where id = $1`,
    [id],
  );
  return row;
}

export async function submissionDocumentId(submissionId: string) {
  const [row] = await query<{ document_id: string }>(
    `select document_id from submission_documents where submission_id = $1 limit 1`,
    [submissionId],
  );
  if (!row) throw new Error("No submission document.");
  return row.document_id;
}

export async function shareCount(submissionId: string) {
  const [row] = await query<{ n: string }>(
    `select count(*)::text as n from submission_shares where submission_id = $1`,
    [submissionId],
  );
  return Number(row.n);
}

/** Scans run in Inngest after the outbox publishes; allow for a cold job. */
export async function waitForCleanScan(table: "documents" | "wallet_documents", id: string) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const [row] = await query<{ scan_status: string }>(`select scan_status from ${table} where id = $1`, [id]);
    if (row?.scan_status === "clean") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${table} row was not scanned in time.`);
}

export async function walletDocumentIds(email: string) {
  const rows = await query<{ id: string }>(
    `select w.id from wallet_documents w
     join candidate_accounts c on c.id = w.candidate_account_id
     join "user" u on u.id = c.user_id
     where u.email = $1 order by w.created_at`,
    [email],
  );
  return rows.map((row) => row.id);
}

export async function walletItemIds(email: string) {
  const rows = await query<{ id: string }>(
    `select w.id from wallet_items w
     join candidate_accounts c on c.id = w.candidate_account_id
     join "user" u on u.id = c.user_id
     where u.email = $1`,
    [email],
  );
  return rows.map((row) => row.id);
}

export async function candidateRowCounts(email: string) {
  const [row] = await query<{ items: string; documents: string; vaults: string }>(
    `select
       (select count(*) from wallet_items w where w.candidate_account_id = c.id)::text as items,
       (select count(*) from wallet_documents w where w.candidate_account_id = c.id)::text as documents,
       (select count(*) from vault_keys v where v.owner_type = 'candidate' and v.owner_id = c.id)::text as vaults
     from candidate_accounts c join "user" u on u.id = c.user_id where u.email = $1`,
    [email],
  );
  return row ? { items: Number(row.items), documents: Number(row.documents), vaults: Number(row.vaults) } : null;
}

export async function apiKeyId(name: string, table: "api_keys" | "candidate_api_keys" = "api_keys") {
  const [row] = await query<{ id: string }>(`select id from ${table} where name = $1`, [name]);
  if (!row) throw new Error("No such key.");
  return row.id;
}

export async function apiKeyRevoked(id: string, table: "api_keys" | "candidate_api_keys" = "api_keys") {
  const [row] = await query<{ revoked_at: Date | null }>(`select revoked_at from ${table} where id = $1`, [id]);
  return Boolean(row?.revoked_at);
}

export async function expireApiKey(name: string, table: "api_keys" | "candidate_api_keys" = "api_keys") {
  await query(`update ${table} set expires_at = (now() at time zone 'utc') - interval '1 hour' where name = $1`, [name]);
}

/** The cookie is `<token>.<signature>`; the session row holds the token. */
export async function expireSession(cookieValue: string) {
  const token = decodeURIComponent(cookieValue).split(".")[0];
  await query(`update session set expires_at = (now() at time zone 'utc') - interval '1 hour' where token = $1`, [token]);
}

export async function suppressed(email: string) {
  const rows = await query(`select 1 from suppressions where email = $1`, [email]);
  return rows.length > 0;
}

/** Every value in every public table, as text, for at-rest leak checks. */
export async function allRowText() {
  const tables = await query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  const chunks: string[] = [];
  for (const { tablename } of tables) {
    const rows = await query<{ row: string }>(`select row_to_json(t)::text as row from "${tablename}" t`);
    for (const row of rows) chunks.push(row.row);
  }
  return chunks.join("\n");
}
