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
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),

    // Scanning
    CLAMAV_HOST: z.string().default("localhost"),
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
    SCAN_DISABLED: z.enum(["true", "false"]).optional(),

    // Email / SMS
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    SHARED_SENDING_DOMAIN: z.string().default("mail.recruvault.example"),
    SMS_ENABLED: boolish,

    // Background jobs
    INNGEST_DEV: z.string().optional(),
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),

    // Observability
    SENTRY_DSN: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== "production") return;
    if (val.SCAN_DISABLED === "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SCAN_DISABLED must not be true in production.",
        path: ["SCAN_DISABLED"],
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parse and memoize the environment. Throws a readable aggregated error. */
export function validateEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
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
