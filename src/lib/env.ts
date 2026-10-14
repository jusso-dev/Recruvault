import { z } from "zod";

/**
 * Environment validation. Parsed once at server boot (src/instrumentation.ts)
 * so misconfiguration fails fast with a readable error instead of surfacing as
 * runtime 500s. Never `.parse()` at module import time in files reachable from
 * `next build` — the build runs without runtime env.
 */

const boolish = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 chars"),
    LINK_SESSION_SECRET: z.string().min(32).optional(),
    ALLOW_RECRUITER_SIGNUP: boolish,

    // Encryption. Self-managed master key (KEK); no external KMS. Keep it
    // secret and backed up — losing it makes all ciphertext unrecoverable.
    LOCAL_KEK: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "LOCAL_KEK must be 32 bytes of hex (openssl rand -hex 32)"),
    AWS_REGION: z.string().default("ap-southeast-2"),

    // Storage
    S3_BUCKET: z.string().min(1),
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: boolish,
    S3_SERVER_SIDE_ENCRYPTION: boolish,
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),

    // Scanning
    CLAMAV_HOST: z.string().default("localhost"),
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
    SCAN_DISABLED: z.enum(["true", "false"]).optional(),

    // Email / SMS
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().email().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    SHARED_SENDING_DOMAIN: z.string().default("mail.recruvault.example"),
    SMS_ENABLED: boolish,

    // Background jobs. Production uses signed Inngest, never the dev server.
    INNGEST_DEV: z.string().optional(),
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),

    // First-owner bootstrap. Required in production. Never a shared default.
    BOOTSTRAP_TOKEN: z.string().optional(),
    BOOTSTRAP_RECOVERY_TOKEN: z.string().optional(),
    // Comma-separated browser origins allowed to call /api/v1. Empty means same-origin only.
    API_CORS_ORIGINS: z.string().optional(),
    PLAYWRIGHT_TEST: z.string().optional(),

    // Observability
    SENTRY_DSN: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== "production") return;
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (val.SCAN_DISABLED === "true") fail("SCAN_DISABLED", "SCAN_DISABLED must not be true in production.");
    if (val.PLAYWRIGHT_TEST === "1") fail("PLAYWRIGHT_TEST", "PLAYWRIGHT_TEST must not be enabled in production.");
    if (!val.BOOTSTRAP_TOKEN || val.BOOTSTRAP_TOKEN.length < 32) {
      fail("BOOTSTRAP_TOKEN", "BOOTSTRAP_TOKEN must be at least 32 characters in production.");
    }
    if (val.INNGEST_DEV) fail("INNGEST_DEV", "INNGEST_DEV must not be set in production.");
    if (!val.INNGEST_SIGNING_KEY) fail("INNGEST_SIGNING_KEY", "INNGEST_SIGNING_KEY is required in production.");
    const defaults = new Set(["recruvault", "recruvault-secret", "password", "postgres", "changeme"]);
    if (val.AWS_ACCESS_KEY_ID && defaults.has(val.AWS_ACCESS_KEY_ID)) {
      fail("AWS_ACCESS_KEY_ID", "Refusing a default object-storage access key in production.");
    }
    if (val.AWS_SECRET_ACCESS_KEY && defaults.has(val.AWS_SECRET_ACCESS_KEY)) {
      fail("AWS_SECRET_ACCESS_KEY", "Refusing a default object-storage secret in production.");
    }
    if (/\/\/recruvault:recruvault@/.test(val.DATABASE_URL) || /:password@/.test(val.DATABASE_URL)) {
      fail("DATABASE_URL", "Refusing a default database password in production.");
    }
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(input: Record<string, unknown>) {
  return schema.safeParse(input);
}

let cached: Env | undefined;

/** Parse and memoize the environment. Throws a readable aggregated error. */
export function validateEnv(): Env {
  if (cached) return cached;
  const parsed = parseEnv(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lazy accessor — validates on first use, never at import time. */
export function getEnv(): Env {
  return validateEnv();
}
