/**
 * Explicit API key capabilities. A key never exceeds the caller's live role,
 * and `legacy:full` is only the migration snapshot of keys that already had
 * the creator's full role. New keys cannot be issued with that scope.
 */

export const API_SCOPES = [
  "reports:read",
  "roles:read",
  "roles:write",
  "jd:write",
  "invitations:send",
  "export:read",
  "profile:read",
  "profile:write",
  "documents:read",
  "documents:write",
  "applications:read",
  "match:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
export const LEGACY_API_SCOPE = "legacy:full";

export const ORG_API_SCOPES = [
  "reports:read",
  "roles:read",
  "roles:write",
  "jd:write",
  "invitations:send",
  "export:read",
  "documents:read",
  "documents:write",
  "match:read",
] as const satisfies readonly ApiScope[];

export const CANDIDATE_API_SCOPES = [
  "profile:read",
  "profile:write",
  "documents:read",
  "documents:write",
  "applications:read",
] as const satisfies readonly ApiScope[];

export const REPORTING_SCOPES = ["reports:read", "roles:read", "documents:read"] as const satisfies readonly ApiScope[];

export const DEFAULT_KEY_TTL_DAYS = 90;
export const MAX_KEY_TTL_DAYS = 365;
export const MAX_ACTIVE_KEYS = 10;
export const RECENT_AUTH_MS = 12 * 60 * 60 * 1000;

const SCOPE_SET = new Set<string>(API_SCOPES);

export function parseRequestedScopes(
  raw: string[],
  allowed: readonly ApiScope[],
): { ok: true; scopes: ApiScope[] } | { ok: false; error: string } {
  const unique = [...new Set(raw.map((scope) => scope.trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: false, error: "Select at least one key scope." };
  if (unique.includes(LEGACY_API_SCOPE)) {
    return { ok: false, error: "New keys cannot use the legacy full-access scope." };
  }
  const allowedSet = new Set<string>(allowed);
  if (unique.some((scope) => !SCOPE_SET.has(scope) || !allowedSet.has(scope))) {
    return { ok: false, error: "One or more key scopes are not available for this account." };
  }
  return { ok: true, scopes: unique as ApiScope[] };
}

export function scopeAllows(granted: readonly string[] | null | undefined, required: ApiScope): boolean {
  if (!granted || granted.length === 0) return false;
  if (granted.includes(LEGACY_API_SCOPE)) return true;
  return granted.includes(required);
}

export function keyExpiry(days: number, now = new Date()): Date | null {
  if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_TTL_DAYS) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isExpired(expiresAt: Date | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

export function recentAuthentication(signedInAt: Date | null | undefined, now = Date.now()): boolean {
  if (!signedInAt) return false;
  return now - signedInAt.getTime() <= RECENT_AUTH_MS;
}

export function routeBudget(scope: ApiScope): { max: number; windowMs: number } {
  switch (scope) {
    case "jd:write":
    case "documents:write":
      return { max: 20, windowMs: 60_000 };
    case "invitations:send":
      return { max: 30, windowMs: 60_000 };
    case "export:read":
      return { max: 10, windowMs: 60_000 };
    case "match:read":
      return { max: 30, windowMs: 60_000 };
    default:
      return { max: 120, windowMs: 60_000 };
  }
}
