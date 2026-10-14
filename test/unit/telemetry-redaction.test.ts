import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "stream";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { createLogger } from "@/lib/logger";
import { redactString, sanitizeForTelemetry, sanitizeUrl } from "@/lib/redact";
import { scrubBreadcrumb, scrubSentryEvent } from "@/lib/telemetry";

const lines = vi.hoisted(() => ({ text: "" }));
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  const { Writable: W } = await import("stream");
  const logger = actual.createLogger(
    new W({
      write(chunk, _encoding, callback) {
        lines.text += chunk.toString();
        callback();
      },
    }),
  );
  return { ...actual, logger, getLogger: (module: string) => logger.child({ module }) };
});
const inserted = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/db", () => {
  const chain = { from: () => chain, where: async () => [] };
  return {
    db: {
      select: () => chain,
      insert: () => ({
        values: async (row: unknown) => {
          inserted.rows.push(row);
        },
      }),
    },
  };
});

// Synthetic canaries only. Every assertion checks that none of these strings
// survive into a log line or a Sentry event.
const C = {
  otp: "481516",
  token: "Zq9vT3kLmN8pR2sW4xY6aB1cD5eF7gH0jK2lM4nP6qR",
  apiKey: "rv_canaryApiKeyValue1234567890abcdef",
  password: "canary-hunter2-password",
  cookie: "better-auth.session_token=canarysessioncookievalue",
  email: "canary.person@example.org",
  phone: "+61412345678",
  auPhone: "0412 345 678",
  customerKey: "ck-canary-customer-key-material-0001",
  awsSecret: "canaryAwsSecretAccessKey/abcdEFGHijkl",
  dbPassword: "canarydbpass",
};
const ALL = Object.values(C);

function capture() {
  let out = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      out += chunk.toString();
      callback();
    },
  });
  return {
    logger: createLogger(stream),
    read: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return out;
    },
  };
}

function expectClean(text: string) {
  for (const canary of ALL) expect(text).not.toContain(canary);
  // The phone without spaces too.
  expect(text).not.toContain(C.auPhone.replace(/\s/g, ""));
}

describe("real logger", () => {
  it("redacts nested causes, headers, provider errors, and query params", async () => {
    const { logger, read } = capture();
    const providerError = Object.assign(new Error(`Resend rejected ${C.email}`), {
      name: "validation_error",
      statusCode: 422,
      cause: new Error(`upstream said otp=${C.otp} for /r/${C.token}`, {
        cause: { headers: { authorization: `Bearer ${C.apiKey}`, cookie: C.cookie, "x-api-key": C.apiKey } },
      }),
    });
    const dbError = new Error(
      `Failed query: insert into "submission_values" ("value") values ($1, $2)\nparams: ${C.email},${C.phone}`,
    );
    logger.error({ err: providerError, orgId: "org-1" }, "resend domain registration failed");
    logger.error({ err: dbError, accessTokenId: "11111111-2222-3333-4444-555555555555" }, "submitResponse failed");
    logger.warn(
      {
        request: {
          url: `https://app.example/r/${C.token}?code=${C.otp}`,
          headers: { Authorization: `Bearer ${C.apiKey}`, Cookie: C.cookie, "Set-Cookie": C.cookie },
          body: { password: C.password, encryptionKey: C.customerKey, recipientPhone: C.auPhone },
        },
        config: { AWS_SECRET_ACCESS_KEY: C.awsSecret, access_token: C.token, refreshToken: C.token },
        dsn: `postgres://app:${C.dbPassword}@db:5432/recruvault`,
        code: C.otp,
      },
      `delivery to ${C.phone} via ${C.auPhone} failed`,
    );
    const output = await read();
    expectClean(output);
    // Useful context survives.
    expect(output).toContain("resend domain registration failed");
    expect(output).toContain("11111111-2222-3333-4444-555555555555");
    expect(output).toContain("Failed query: insert into");
    expect(output).toContain("/r/[redacted]");
  });

  it("redacts an error passed as the first argument and the message string", async () => {
    const { logger, read } = capture();
    logger.child({ module: "test" }).error(new Error(`connect postgres://u:${C.dbPassword}@db failed for ${C.email}`));
    logger.info(`magic link https://app.example/api/auth/magic-link/verify?token=${C.token}&callbackURL=/`);
    logger.info({ ctaUrl: `https://app.example/reset-password/${C.token}` }, "email (dev fallback, not sent)");
    const output = await read();
    expectClean(output);
    expect(output).toContain("email (dev fallback, not sent)");
  });

  it("keeps error codes but removes OTP-shaped codes", () => {
    const out = sanitizeForTelemetry({ code: "ECONNREFUSED", nested: { code: "23505" }, otp: { code: C.otp } });
    expect(out).toEqual({ code: "ECONNREFUSED", nested: { code: "23505" }, otp: "[redacted]" });
    expect(sanitizeForTelemetry({ code: 481516 })).toEqual({ code: "[redacted]" });
  });

  it("keeps route shape and correlation ids", () => {
    expect(sanitizeUrl(`https://app.example/r/${C.token}?token=x#frag`)).toBe("https://app.example/r/[redacted]?[redacted]");
    expect(sanitizeForTelemetry({ route: "/api/v1/requests/[id]", requestId: "abc", keyVersion: 3, otpAttempts: 2 })).toEqual({
      route: "/api/v1/requests/[id]",
      requestId: "abc",
      keyVersion: 3,
      otpAttempts: 2,
    });
    expect(redactString(`-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----`)).toBe("[redacted-key]");
  });
});

describe("vault key fields", () => {
  it("redacts every customer-key, passphrase, and recovery field by name", async () => {
    const fields = [
      "passphrase",
      "passphraseConfirm",
      "currentEncryptionKey",
      "encryptionKey",
      "encryptionKeyConfirm",
      "newEncryptionKey",
      "crk",
      "wrappedCrk",
      "recoveryToken",
      "bootstrapToken",
      "BOOTSTRAP_RECOVERY_TOKEN",
    ];
    const canaries = Object.fromEntries(fields.map((field, i) => [field, `vaultcanary${i}x`]));
    const { logger, read } = capture();
    logger.info({ form: canaries, nested: { cause: { body: canaries } } }, "vault action failed");
    logger.info(canaries, "top level");
    const output = await read();
    for (const value of Object.values(canaries)) expect(output).not.toContain(value);
    const sanitized = JSON.stringify(sanitizeForTelemetry({ deep: { deeper: canaries } }));
    for (const value of Object.values(canaries)) expect(sanitized).not.toContain(value);
  });
});

describe("sentry beforeSend", () => {
  it("strips request bodies, headers, cookies, queries, user contact, and frame vars", () => {
    const event = scrubSentryEvent({
      transaction: `/r/${C.token}`,
      request: {
        url: `https://app.example/r/${C.token}?code=${C.otp}`,
        query_string: `code=${C.otp}`,
        cookies: { session: C.cookie },
        data: { password: C.password, encryptionKey: C.customerKey },
        headers: { authorization: `Bearer ${C.apiKey}`, cookie: C.cookie },
        env: { REMOTE_ADDR: "203.0.113.9" },
      },
      user: { id: "user-1", email: C.email, ip_address: "203.0.113.9" },
      breadcrumbs: [
        { category: "fetch", data: { url: `https://api.resend.com/emails?to=${C.email}`, status_code: 422 } },
        { category: "console", message: `otp ${C.otp} for ${C.phone}` },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: `Failed query: select 1\nparams: ${C.email}`,
            stacktrace: { frames: [{ filename: "app/actions/link.ts", vars: { code: C.otp, token: C.token } }] },
          },
        ],
      },
      extra: { cause: { cause: { headers: { "x-api-key": C.apiKey } } } },
    });
    const text = JSON.stringify(event);
    expectClean(text);
    expect(text).not.toContain("203.0.113.9");
    expect(event.request.url).toBe("https://app.example/r/[redacted]?[redacted]");
    expect(event.user).toEqual({ id: "user-1" });
    expect(text).toContain("app/actions/link.ts");
    expect(JSON.stringify(scrubBreadcrumb({ data: { url: `/r/${C.token}` } }))).not.toContain(C.token);
  });
});

describe("delivery fallbacks and environment matrix", () => {
  const env = { ...process.env };
  const outbox = join(process.cwd(), ".playwright", "outbox");
  let consoleSpy: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];

  beforeEach(() => {
    lines.text = "";
    inserted.rows = [];
    consoleSpy = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    process.env = { ...env };
    for (const spy of consoleSpy) spy.mockRestore();
  });

  const consoleText = () =>
    consoleSpy.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");

  it("never prints an SMS body, in development or production", async () => {
    const { sendSms } = await import("@/lib/sms");
    for (const nodeEnv of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      delete process.env.SMS_ENABLED;
      const sent = await sendSms({
        orgId: "org-1",
        to: C.phone,
        message: `Acme sent you a secure request via Recruvault: https://app.example/r/${C.token}`,
      });
      expect(sent).toBe(false);
    }
    vi.unstubAllEnvs();
    expectClean(lines.text + consoleText() + JSON.stringify(inserted.rows));
    expect(JSON.stringify(inserted.rows)).toContain("skipped_disabled");
  });

  it("fails production email without a provider and never logs the code or link", async () => {
    const { sendEmail } = await import("@/lib/email");
    const message = {
      to: C.email,
      subject: "Your Recruvault verification code",
      heading: "Your verification code",
      body: "Enter this code.",
      code: C.otp,
      ctaUrl: `https://app.example/r/${C.token}`,
    };
    delete process.env.RESEND_API_KEY;

    vi.stubEnv("NODE_ENV", "production");
    await expect(sendEmail(message)).rejects.toThrow("Email delivery is not configured.");

    vi.stubEnv("NODE_ENV", "development");
    await expect(sendEmail(message)).resolves.toBeNull();
    vi.unstubAllEnvs();

    expectClean(lines.text + consoleText());
    expect(lines.text).toContain("not-sent");
  });

  it("refuses the Playwright mailbox and scan bypass in production", async () => {
    const { sendEmail } = await import("@/lib/email");
    const { scanBytes } = await import("@/lib/scan");
    const before = existsSync(outbox) ? readdirSync(outbox).length : 0;
    process.env.RESEND_API_KEY = "";
    vi.stubEnv("PLAYWRIGHT_TEST", "1");
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      sendEmail({ to: C.email, subject: "s", heading: "h", body: "b", code: C.otp }),
    ).rejects.toThrow();
    expect(existsSync(outbox) ? readdirSync(outbox).length : 0).toBe(before);

    vi.stubEnv("SCAN_DISABLED", "true");
    await expect(scanBytes(Buffer.from("%PDF-1.7 test"))).rejects.toThrow(/production/);
    vi.unstubAllEnvs();
    if (before === 0 && existsSync(outbox)) rmSync(outbox, { recursive: true, force: true });
  });
});
