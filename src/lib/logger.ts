import pino from "pino";

/**
 * Structured logging. Operational telemetry (KMS/ClamAV/S3 failures, job
 * outcomes) — distinct from the compliance audit trail. PII fields are redacted.
 * No `import "server-only"` here so the logger is importable from Vitest.
 */

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["email", "recipient", "recipientEmail", "to", "*.email", "*.recipient"],
    censor: "[redacted]",
  },
});

export function getLogger(module: string) {
  return logger.child({ module });
}
