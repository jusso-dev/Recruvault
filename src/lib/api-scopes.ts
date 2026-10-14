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
  "submissions:read",
  "profile:read",
  "profile:write",
  "documents:read",
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
  "submissions:read",
  "match:read",
] as const satisfies readonly ApiScope[];

export const CANDIDATE_API_SCOPES = [
  "profile:read",
  "profile:write",
  "documents:read",
  "applications:read",
] as const satisfies readonly ApiScope[];

/**
 * Read-only reporting keys for common agent tasks. They cannot create roles,
 * upload JDs, send invitations, list submissions, or change a profile.
 */
export const REPORTING_SCOPES = ["reports:read", "roles:read"] as const satisfies readonly ApiScope[];
export const CANDIDATE_READ_SCOPES = [
  "profile:read",
  "documents:read",
  "applications:read",
] as const satisfies readonly ApiScope[];

export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "reports:read": "Read recruiter reports",
  "roles:read": "List and read roles",
  "roles:write": "Create roles",
  "jd:write": "Upload job descriptions",
  "invitations:send": "Send secure links (outbound email)",
  "submissions:read": "Export submission metadata",
  "profile:read": "Read discovery profile",
  "profile:write": "Change discovery profile",
  "documents:read": "Read career-document metadata",
  "applications:read": "Read applications",
  "match:read": "Match candidates",
};

export const DEFAULT_KEY_TTL_DAYS = 90;
export const MAX_KEY_TTL_DAYS = 365;
/** Active keys per user (organisation) or per job seeker. */
export const MAX_ACTIVE_KEYS = 10;
/** Active keys across a whole organisation. */
export const MAX_ORG_ACTIVE_KEYS = 50;
/** Creating or rotating a key needs a session this fresh, or the password. */
export const RECENT_AUTH_MS = 15 * 60 * 1000;

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

export interface Budget {
  max: number;
  windowMs: number;
}

/** Route-specific budget: uploads, outbound delivery, exports, and matching are tighter. */
export function routeBudget(scope: ApiScope): Budget {
  switch (scope) {
    case "jd:write":
      return { max: 20, windowMs: 60_000 };
    case "invitations:send":
      return { max: 30, windowMs: 60_000 };
    case "submissions:read":
      return { max: 30, windowMs: 60_000 };
    case "match:read":
      return { max: 30, windowMs: 60_000 };
    default:
      return { max: 120, windowMs: 60_000 };
  }
}

/** Budgets shared by every route, applied on top of the route budget. */
export const GLOBAL_BUDGETS = {
  key: { max: 300, windowMs: 60_000 },
  principal: { max: 600, windowMs: 60_000 },
  tenant: { max: 1200, windowMs: 60_000 },
} as const satisfies Record<string, Budget>;
