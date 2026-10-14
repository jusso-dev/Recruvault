/**
 * Shared redaction for operational logs and error telemetry. Compliance audit
 * rows are a separate store and must also stay free of ciphertext and keys.
 */

// Key names are compared after lower-casing and removing `_`, `-`, and spaces,
// so `access_token`, `X-Api-Key`, and `AWS_SECRET_ACCESS_KEY` all match.
const SECRET_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "otp",
  "verificationcode",
  "encryptionkey",
  "customerkey",
  "wrappedkey",
  "backupkey",
  "kek",
  "bootstrap",
  "verifier",
  "signature",
  "credential",
  "crk",
  "recovery",
  "ctaurl",
  "link",
  "reseturl",
  "magiclink",
  "dsn",
  "email",
  "recipient",
  "phone",
  "dedupekey",
  "storagekey",
];
// Identifiers, counters, and timestamps stay so a line can still be correlated.
const SAFE_KEY_SUFFIX = /(id|ids|count|version|type|status|at|attempts|suffix|prefix)$/;
const URL_KEYS = new Set(["url", "href", "path", "pathname", "route", "referer", "referrer", "transaction"]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_KEY = /\brv_[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET =
  /([?&#;](?:token|code|otp|key|email|password|secret|signature|sig|access_token|refresh_token|id_token|callbackurl|phone)=)[^&#\s]+/gi;
// Capability paths: secure request links, invitations, password reset, and
// magic-link/verification callbacks.
const PATH_SECRET =
  /(\/(?:r|invite|invitation|invitations|reset-password|reset|verify|verify-email|magic-link|magic|callback)\/)[A-Za-z0-9._~%-]{8,}/gi;
const URL_CREDENTIALS = /(\/\/)[^/@\s:]+:[^/@\s]+@/g;
// Drizzle and node-postgres put bound values after "params:".
const QUERY_PARAMS = /(params:)[^\n]*/gi;
const PEM = /-----BEGIN [A-Z ]*KEY-----[\s\S]*?(-----END [A-Z ]*KEY-----|$)/g;
const PHONE_E164 = /\+\d[\d\s-]{7,15}\d/g;
const PHONE_AU = /\b0[45]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
// Long opaque base64url/hex runs (raw tokens, keys, hashes). UUIDs are shorter.
const OPAQUE = /\b[A-Za-z0-9_-]{40,}\b/g;
const OTP_VALUE = /^\d{6,8}$/;
const OTP_TEXT = /\b(otp|passcode|one-time code|verification code|code)(\s*(?:is|:|=)?\s*)\d{4,8}\b/gi;

export function redactString(value: string): string {
  return value
    .replace(PEM, "[redacted-key]")
    .replace(BEARER, "$1 [redacted]")
    .replace(API_KEY, "rv_[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(PATH_SECRET, "$1[redacted]")
    .replace(QUERY_PARAMS, "$1 [redacted]")
    .replace(OTP_TEXT, "$1$2[redacted]")
    .replace(EMAIL, "[redacted-email]")
    .replace(PHONE_E164, "[redacted-phone]")
    .replace(PHONE_AU, "[redacted-phone]")
    .replace(OPAQUE, "[redacted]");
}

/**
 * Keep a URL's route shape for debugging while dropping the query, fragment,
 * userinfo, and capability segments.
 */
export function sanitizeUrl(value: string): string {
  const [withoutFragment] = value.split("#");
  const [base, query] = withoutFragment.split("?");
  return redactString(base) + (query !== undefined ? "?[redacted]" : "");
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (k === "key" || k === "code" || k === "to") return true;
  if (SAFE_KEY_SUFFIX.test(k)) return false;
  return SECRET_KEY_PARTS.some((part) => k.includes(part)) || k.endsWith("key");
}

function sanitizeEntry(key: string, value: unknown, depth: number): unknown {
  const k = normaliseKey(key);
  // `code` is usually an error code (ECONNREFUSED, 23505). Only a bare
  // numeric value shaped like a one-time code is removed.
  if (k === "code") {
    if (typeof value === "string" && !OTP_VALUE.test(value)) return redactString(value);
    if (typeof value === "number" && !OTP_VALUE.test(String(value))) return value;
    return "[redacted]";
  }
  if (URL_KEYS.has(k) && typeof value === "string") return sanitizeUrl(value);
  if (isSecretKey(key)) return "[redacted]";
  return sanitizeForTelemetry(value, depth + 1);
}

export function sanitizeForTelemetry(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean" || input == null) return input;
  if (input instanceof Error) {
    const code = (input as { code?: unknown }).code;
    return sanitizeForTelemetry(
      {
        name: input.name,
        message: input.message,
        ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
        cause: (input as { cause?: unknown }).cause,
      },
      depth + 1,
    );
  }
  if (Array.isArray(input)) return input.map((entry) => sanitizeForTelemetry(entry, depth + 1));
  if (input instanceof Date) return input.toISOString();
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = sanitizeEntry(key, value, depth);
    }
    return out;
  }
  return "[redacted]";
}

export const PINO_REDACT_PATHS = [
  "email",
  "recipient",
  "recipientEmail",
  "recipientPhone",
  "phone",
  "to",
  // Top-level only: nested error codes (err.code) stay for debugging.
  "code",
  "ctaUrl",
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
  "*.recipientPhone",
  "*.phone",
  "*.to",
  "*.ctaUrl",
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
