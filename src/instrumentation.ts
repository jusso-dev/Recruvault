/**
 * Next.js instrumentation. `register()` runs once at server boot (Node runtime
 * only) — not during `next build` — so env validation and optional Sentry
 * init happen at startup without breaking env-less builds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateEnv } = await import("@/lib/env");
  validateEnv();

  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
  }
}

export const onRequestError = async (
  ...args: Parameters<
    NonNullable<typeof import("@sentry/nextjs")["captureRequestError"]>
  >
) => {
  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...args);
  }
};
