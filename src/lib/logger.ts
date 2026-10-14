import pino from "pino";
import { PINO_REDACT_PATHS, sanitizeForTelemetry } from "@/lib/redact";

/**
 * Structured logging. Operational telemetry (storage, scanning, job outcomes)
 * is distinct from the compliance audit trail. Secrets and contact details are
 * removed before the line is written.
 * No `import "server-only"` here so the logger is importable from Vitest.
 */

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: PINO_REDACT_PATHS,
    censor: "[redacted]",
  },
  formatters: {
    log(object) {
      return sanitizeForTelemetry(object) as Record<string, unknown>;
    },
  },
});

export function getLogger(module: string) {
  return logger.child({ module });
}
