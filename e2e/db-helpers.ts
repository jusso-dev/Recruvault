import { createHash, randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { Client, type QueryResultRow } from "pg";
import { createEmailVerificationToken } from "better-auth/api";

loadEnvConfig(process.cwd());

async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query<T>(text, values);
  } finally {
    await client.end();
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function verifyUserEmail(email: string) {
  await setUserEmailVerified(email, true);
}

export async function emailVerificationToken(email: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for email verification tests.");
  return createEmailVerificationToken(secret, email);
}

export async function setUserEmailVerified(email: string, verified: boolean) {
  await query(`update "user" set email_verified = $2 where email = $1`, [email, verified]);
}

export async function passwordResetTokenForEmail(email: string) {
  const result = await query<{ identifier: string }>(
    `select v.identifier
     from verification v
     inner join "user" u on u.id = v.value
     where u.email = $1 and v.identifier like 'reset-password:%'
     order by v.created_at desc
     limit 1`,
    [email],
  );
  const identifier = result.rows[0]?.identifier;
  if (!identifier) throw new Error(`No password reset token found for ${email}`);
  return identifier.slice("reset-password:".length);
}

export async function requestIdForTitle(title: string) {
  const result = await query<{ id: string }>(
    `select id from requests where title = $1 order by created_at desc limit 1`,
    [title],
  );
  if (!result.rows[0]) throw new Error(`No role found with title ${title}`);
  return result.rows[0].id;
}

export async function createSecureInvitation(requestId: string, recipientEmail: string) {
  const rawToken = randomBytes(32).toString("base64url");
  const token = await query<{ id: string }>(
    `insert into access_tokens (request_id, token_hash, recipient_email, expires_at)
     values ($1, $2, $3, now() + interval '2 days') returning id`,
    [requestId, sha256(rawToken), recipientEmail.toLowerCase()],
  );
  await query(
    `insert into deliveries (request_id, access_token_id, channel, recipient, status)
     values ($1, $2, 'email', $3, 'sent')`,
    [requestId, token.rows[0].id, recipientEmail.toLowerCase()],
  );
  return rawToken;
}

export async function setKnownOtp(rawToken: string, code: string) {
  await query(
    `update access_tokens
     set otp_hash = $1, otp_expires_at = now() + interval '10 minutes', otp_attempts = 0
     where token_hash = $2`,
    [sha256(code), sha256(rawToken)],
  );
}

export async function submissionIdForRequest(requestId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await query<{ id: string }>(
      `select id from submissions where request_id = $1 order by created_at desc limit 1`,
      [requestId],
    );
    if (result.rows[0]) return result.rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Submission was not created in time.");
}
