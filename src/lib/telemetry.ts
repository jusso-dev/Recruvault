import { sanitizeForTelemetry, sanitizeUrl } from "@/lib/redact";

/**
 * Sentry event scrubbing. Request bodies, cookies, headers, query strings, and
 * user contact fields never leave the process. URLs keep their route shape with
 * capability segments removed, so errors stay groupable by route.
 */

type Scrubbable = {
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string>;
    env?: unknown;
  };
  user?: { id?: string | number; [key: string]: unknown };
  breadcrumbs?: unknown[];
  exception?: { values?: { stacktrace?: { frames?: { vars?: unknown }[] } }[] };
  [key: string]: unknown;
};

export function scrubSentryEvent<T>(event: T): T {
  const e = event as Scrubbable;
  if (e.request) {
    delete e.request.cookies;
    delete e.request.data;
    delete e.request.query_string;
    delete e.request.env;
    e.request.headers = {};
    if (typeof e.request.url === "string") e.request.url = sanitizeUrl(e.request.url);
  }
  if (e.user) e.user = e.user.id !== undefined ? { id: e.user.id } : {};
  for (const value of e.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) delete frame.vars;
  }
  return sanitizeForTelemetry(e) as T;
}

export function scrubBreadcrumb<T>(breadcrumb: T): T {
  return sanitizeForTelemetry(breadcrumb) as T;
}
