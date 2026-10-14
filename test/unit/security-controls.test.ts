import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "stream";
import { PINO_REDACT_PATHS, redactString, sanitizeForTelemetry } from "@/lib/redact";
import { buildContentSecurityPolicy } from "@/lib/csp";
import { scopeAllows, parseRequestedScopes, isExpired, keyExpiry, REPORTING_SCOPES } from "@/lib/api-scopes";
import { readEnrollmentKey } from "@/lib/vault-enrollment";
import { parseEnv } from "@/lib/env";

describe("telemetry redaction", () => {
  it("removes nested secrets, emails, and api keys", () => {
    const sanitized = sanitizeForTelemetry({
      route: "/api/v1/requests",
      headers: { authorization: "Bearer rv_supersecretvalue", cookie: "session=abc" },
      cause: { password: "hunter2", note: "mail user@example.com and rv_abcdefghijklmnopqrstuvwxyz" },
    }) as { headers: { authorization: string }; cause: { password: string; note: string } };
    expect(sanitized.headers.authorization).toBe("[redacted]");
    expect(sanitized.cause.password).toBe("[redacted]");
    expect(sanitized.cause.note).not.toContain("user@example.com");
    expect(sanitized.cause.note).not.toContain("rv_abcdefghijklmnopqrstuvwxyz");
    expect(redactString("https://app.example/reset?token=abc123&ok=1")).toContain("token=[redacted]");
  });

  it("does not write canary secrets through the logger", async () => {
    let line = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        line += chunk.toString();
        callback();
      },
    });
    const logger = pino({
      redact: { paths: PINO_REDACT_PATHS, censor: "[redacted]" },
    }, stream);
    const canary = "otp-canary-918273";
    logger.info({ code: canary, ctaUrl: `https://app.example/r/${canary}` }, "delivery failed");
    await new Promise((resolve) => stream.end(resolve));
    expect(line).not.toContain(canary);
  });
});

describe("content security policy", () => {
  it("omits unsafe-inline and unsafe-eval from production scripts", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "nonce-a",
      isDev: false,
      connectSources: ["https://app.example"],
    });
    expect(policy).toContain("script-src 'self' 'nonce-nonce-a' 'strict-dynamic'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy({ nonce: "other", isDev: false, connectSources: [] })).not.toContain("nonce-a");
  });
});

describe("api scopes", () => {
  it("keeps a reporting key from writing roles", () => {
    expect(scopeAllows(REPORTING_SCOPES, "reports:read")).toBe(true);
    expect(scopeAllows(REPORTING_SCOPES, "roles:write")).toBe(false);
    expect(scopeAllows(["legacy:full"], "roles:write")).toBe(true);
    expect(parseRequestedScopes(["legacy:full"], ["roles:read"]).ok).toBe(false);
    expect(isExpired(null)).toBe(true);
    expect(keyExpiry(90)).toBeInstanceOf(Date);
    expect(keyExpiry(400)).toBeNull();
  });
});

describe("enrollment form", () => {
  it("requires a saved-key acknowledgement and matching confirmation", () => {
    const missing = new FormData();
    missing.set("encryptionKey", "a".repeat(43));
    expect(readEnrollmentKey(missing).ok).toBe(false);
    const mismatch = new FormData();
    mismatch.set("keyBackupAck", "yes");
    mismatch.set("encryptionKey", "abcd");
    mismatch.set("encryptionKeyConfirm", "abcd");
    expect(readEnrollmentKey(mismatch).ok).toBe(false);
  });
});

describe("production environment", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://app:unique-secret@db:5432/recruvault",
    BETTER_AUTH_SECRET: "x".repeat(32),
    LOCAL_KEK: "ab".repeat(32),
    S3_BUCKET: "records",
    AWS_ACCESS_KEY_ID: "real-access-key",
    AWS_SECRET_ACCESS_KEY: "real-secret-key",
    BOOTSTRAP_TOKEN: "b".repeat(32),
    INNGEST_SIGNING_KEY: "sign",
  };

  it("rejects default credentials, the dev job server, and the test mailbox", () => {
    expect(parseEnv({ ...base, DATABASE_URL: "postgres://recruvault:recruvault@db/recruvault" }).success).toBe(false);
    expect(parseEnv({ ...base, AWS_SECRET_ACCESS_KEY: "recruvault-secret" }).success).toBe(false);
    expect(parseEnv({ ...base, INNGEST_DEV: "http://inngest:8288" }).success).toBe(false);
    expect(parseEnv({ ...base, PLAYWRIGHT_TEST: "1" }).success).toBe(false);
    expect(parseEnv({ ...base, SCAN_DISABLED: "true" }).success).toBe(false);
    expect(parseEnv(base).success).toBe(true);
  });
});
