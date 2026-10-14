import pino from "pino";
import { PINO_REDACT_PATHS, redactString, sanitizeForTelemetry } from "@/lib/redact";

/**
 * Structured logging. Operational telemetry (storage, scanning, job outcomes)
 * is distinct from the compliance audit trail. Secrets and contact details are
 * removed before the line is written, including the message string and any
 * error passed as the first argument.
 * No `import "server-only"` here so the logger is importable from Vitest.
 */

export function createLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: PINO_REDACT_PATHS,
        censor: "[redacted]",
      },
      hooks: {
        logMethod(args, method) {
          const clean = args.map((arg) =>
            typeof arg === "string" ? redactString(arg) : sanitizeForTelemetry(arg),
          );
          return method.apply(this, clean as Parameters<typeof method>);
        },
      },
      formatters: {
        log(object) {
          return sanitizeForTelemetry(object) as Record<string, unknown>;
        },
      },
    },
    destination,
  );
}

export const logger = createLogger();

export function getLogger(module: string) {
  return logger.child({ module });
}
