/**
 * Shared redaction for operational logs and error telemetry. Compliance audit
 * rows are a separate store and must also stay free of ciphertext and keys.
 */

const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|password|passwd|otp|code|token|ctaurl|url|encryptionkey|customerkey|bootstrap|bootstraptoken|apikey|secret|secretaccesskey|r2secretaccesskey|r2secret|backupkey|wrappedkey|localkek|key|privatekey|verifier|link|reseturl|magiclink)$/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_KEY = /\brv_[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET = /([?&#](?:token|code|otp|key|email)=)[^&#\s]+/gi;

export function redactString(value: string): string {
  return value
    .replace(BEARER, "Bearer [redacted]")
    .replace(API_KEY, "rv_[redacted]")
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(EMAIL, "[redacted-email]");
}

export function sanitizeForTelemetry(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean" || input == null) return input;
  if (input instanceof Error) {
    return sanitizeForTelemetry(
      { name: input.name, message: input.message, cause: (input as { cause?: unknown }).cause },
      depth + 1,
    );
  }
  if (Array.isArray(input)) return input.map((entry) => sanitizeForTelemetry(entry, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitizeForTelemetry(value, depth + 1);
    }
    return out;
  }
  return "[redacted]";
}

export const PINO_REDACT_PATHS = [
  "email",
  "recipient",
  "recipientEmail",
  "to",
  "code",
  "ctaUrl",
  "url",
  "password",
  "token",
  "authorization",
  "cookie",
  "set-cookie",
  "encryptionKey",
  "customerKey",
  "bootstrapToken",
  "apiKey",
  "key",
  "secret",
  "wrappedKey",
  "*.email",
  "*.recipient",
  "*.recipientEmail",
  "*.to",
  "*.code",
  "*.ctaUrl",
  "*.url",
  "*.password",
  "*.token",
  "*.authorization",
  "*.cookie",
  "*.encryptionKey",
  "*.customerKey",
  "*.bootstrapToken",
  "*.apiKey",
  "*.key",
  "*.secret",
  "*.headers.authorization",
  "*.headers.cookie",
  "*.headers['set-cookie']",
  "err.config.headers.authorization",
  "err.config.headers.cookie",
];
