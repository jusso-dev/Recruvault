import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import {
  apiKeys,
  candidateAccounts,
  candidateApiKeys,
  memberships,
  organisations,
  user,
} from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import {
  requireCandidate,
  requireOrgUser,
  AuthError,
  type CandidateContext,
  type OrgContext,
} from "@/lib/guards";
import { can, type Permission } from "@/lib/rbac";
import {
  GLOBAL_BUDGETS,
  LEGACY_API_SCOPE,
  isExpired,
  scopeAllows,
  routeBudget,
  type ApiScope,
} from "@/lib/api-scopes";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { openCredentialWrap, verifierMatches } from "@/lib/vault-crypto";
import { consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/api/http";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/client-ip";

export const API_KEY_PREFIX = "rv_";

/** `credentialId` is the API key id, or null for a browser session. */
export type ApiOrgContext = OrgContext & { credentialId: string | null };
export type ApiCandidateContext = CandidateContext & { credentialId: string | null };

// Scopes whose every use is written to the audit trail with the key id.
const AUDITED_SCOPES = new Set<ApiScope>([
  "roles:write",
  "jd:write",
  "invitations:send",
  "submissions:read",
  "profile:write",
  "match:read",
]);

const INVALID_KEY = "Invalid, expired, or revoked API key. Create a new key in Recruvault and update the client.";

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  // A presented credential is never ignored in favour of a session cookie.
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer?.startsWith(API_KEY_PREFIX)) throw new AuthError(INVALID_KEY);
  return bearer;
}

/**
 * Shared request budgets: per key (all routes), per principal, per tenant,
 * per IP for the route, and the route-specific key budget. All counters live
 * in PostgreSQL so every instance draws from the same windows. Retry-After is
 * the longest remaining wait among the exceeded windows.
 */
async function enforceBudget(opts: {
  keyId: string | null;
  principal: string;
  tenant: string | null;
  ip: string;
  scope: ApiScope;
}) {
  const route = routeBudget(opts.scope);
  const checks = [
    consumeRateLimit(`api-route:${opts.keyId ?? opts.principal}:${opts.scope}`, route.max, route.windowMs),
    consumeRateLimit(`api-ip:${opts.ip}:${opts.scope}`, route.max * 2, route.windowMs),
    consumeRateLimit(`api-principal:${opts.principal}`, GLOBAL_BUDGETS.principal.max, GLOBAL_BUDGETS.principal.windowMs),
  ];
  if (opts.keyId) {
    checks.push(consumeRateLimit(`api-key:${opts.keyId}`, GLOBAL_BUDGETS.key.max, GLOBAL_BUDGETS.key.windowMs));
  }
  if (opts.tenant) {
    checks.push(consumeRateLimit(`api-tenant:${opts.tenant}`, GLOBAL_BUDGETS.tenant.max, GLOBAL_BUDGETS.tenant.windowMs));
  }
  const denied = (await Promise.all(checks)).filter((result) => !result.allowed);
  if (denied.length > 0) {
    throw new RateLimitError(Math.max(...denied.map((result) => result.retryAfterSeconds)));
  }
}

async function assertVaultDelegation(opts: {
  ownerType: "organisation" | "candidate";
  ownerId: string;
  token: string;
  wrappedVaultKey: string | null;
  scopes: readonly string[];
}) {
  const vault = await activeVault(opts.ownerType, opts.ownerId);
  if (!vault || !vault.privateKeyWrapped) {
    throw new AuthError("Encryption enrollment is required.");
  }
  if (!opts.wrappedVaultKey) {
    // Migration policy: keys minted before encryption enrollment (including
    // every legacy:full key) carry no vault delegation and are not upgraded.
    throw new AuthError(
      opts.scopes.includes(LEGACY_API_SCOPE)
        ? "This legacy API key must be replaced. Create a new scoped key in Recruvault."
        : "This API key was issued before encryption enrollment. Create a new key.",
    );
  }
  try {
    const crk = openCredentialWrap(opts.token, opts.wrappedVaultKey);
    if (!verifierMatches(crk, opts.ownerType, opts.ownerId, vault.verifier)) {
      throw new AuthError(INVALID_KEY);
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(INVALID_KEY);
  }
}

function missingScope(scope: ApiScope): AuthError {
  return new AuthError(`This API key does not include the required scope (${scope}).`);
}

async function auditApiUse(opts: {
  orgId: string | null;
  actorType: "org_user" | "candidate";
  actorId: string;
  credentialId: string | null;
  scope: ApiScope;
  req: NextRequest;
}) {
  if (!opts.credentialId || !AUDITED_SCOPES.has(opts.scope)) return;
  await audit({
    orgId: opts.orgId,
    actorType: opts.actorType,
    actorId: opts.actorId,
    action: `api.${opts.scope}`,
    targetType: opts.actorType === "org_user" ? "api_key" : "candidate_api_key",
    targetId: opts.credentialId,
    ip: clientIp(opts.req.headers),
    userAgent: opts.req.headers.get("user-agent"),
  });
}

/**
 * Resolve an organisation caller from an API key or the session. The scope is
 * required: every v1 route names the capability it needs, and a key is also
 * held to the creator's live role and membership.
 */
export async function resolveOrgContext(
  req: NextRequest,
  permission: Permission | null,
  scope: ApiScope,
): Promise<ApiOrgContext> {
  const bearer = bearerToken(req);
  const ip = clientIp(req.headers);
  if (bearer) {
    const ctx = await contextFromApiKey(bearer, scope, ip);
    if (permission && !can(ctx.role, permission)) {
      throw new AuthError(`Your role does not allow this action (${permission}).`);
    }
    await auditApiUse({ orgId: ctx.orgId, actorType: "org_user", actorId: ctx.userId, credentialId: ctx.credentialId, scope, req });
    return ctx;
  }
  const ctx = await requireOrgUser(permission ?? undefined);
  if (!(await activeVault("organisation", ctx.orgId)) || !(await readUnlockedCustomerKey("organisation", ctx.orgId))) {
    throw new AuthError("Encryption enrollment is required.");
  }
  await enforceBudget({ keyId: null, principal: ctx.userId, tenant: ctx.orgId, ip, scope });
  return { ...ctx, credentialId: null };
}

async function loadOrgKey(token: string) {
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      orgId: apiKeys.orgId,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      wrappedVaultKey: apiKeys.wrappedVaultKey,
      role: memberships.role,
      orgSlug: organisations.slug,
      orgName: organisations.name,
      userEmail: user.email,
      userName: user.name,
      emailVerified: user.emailVerified,
      erasedAt: user.erasedAt,
      accountType: user.accountType,
    })
    .from(apiKeys)
    // Inner join: a removed member's keys stop working even before revocation.
    .innerJoin(
      memberships,
      and(eq(memberships.userId, apiKeys.userId), eq(memberships.orgId, apiKeys.orgId)),
    )
    .innerJoin(organisations, eq(organisations.id, apiKeys.orgId))
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, sha256(token)), isNull(apiKeys.revokedAt)));
  if (!row || row.erasedAt || row.accountType !== "org" || isExpired(row.expiresAt)) {
    throw new AuthError(INVALID_KEY);
  }
  if (!row.emailVerified) throw new AuthError("Verify your email address before continuing.");
  return row;
}

async function contextFromApiKey(token: string, scope: ApiScope, ip: string): Promise<ApiOrgContext> {
  const row = await loadOrgKey(token);
  if (!scopeAllows(row.scopes, scope)) throw missingScope(scope);
  await enforceBudget({ keyId: row.keyId, principal: row.userId, tenant: row.orgId, ip, scope });
  await assertVaultDelegation({
    ownerType: "organisation",
    ownerId: row.orgId,
    token,
    wrappedVaultKey: row.wrappedVaultKey,
    scopes: row.scopes,
  });

  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.keyId))
    .catch(() => {});

  return {
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName,
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    role: row.role,
    credentialId: row.keyId,
  };
}

export async function resolveCandidateContext(
  req: NextRequest,
  scope: ApiScope,
): Promise<ApiCandidateContext> {
  const bearer = bearerToken(req);
  const ip = clientIp(req.headers);
  if (bearer) {
    const ctx = await candidateFromApiKey(bearer, scope, ip);
    await auditApiUse({ orgId: null, actorType: "candidate", actorId: ctx.candidateAccountId, credentialId: ctx.credentialId, scope, req });
    return ctx;
  }
  const ctx = await requireCandidate();
  if (
    !(await activeVault("candidate", ctx.candidateAccountId)) ||
    !(await readUnlockedCustomerKey("candidate", ctx.candidateAccountId))
  ) {
    throw new AuthError("Encryption enrollment is required.");
  }
  await enforceBudget({ keyId: null, principal: ctx.userId, tenant: null, ip, scope });
  return { ...ctx, credentialId: null };
}

async function loadCandidateKey(token: string) {
  const [row] = await db
    .select({
      keyId: candidateApiKeys.id,
      name: candidateApiKeys.name,
      prefix: candidateApiKeys.prefix,
      candidateAccountId: candidateApiKeys.candidateAccountId,
      scopes: candidateApiKeys.scopes,
      expiresAt: candidateApiKeys.expiresAt,
      wrappedVaultKey: candidateApiKeys.wrappedVaultKey,
      userId: candidateAccounts.userId,
      userEmail: user.email,
      userName: user.name,
      erasedAt: user.erasedAt,
      emailVerified: user.emailVerified,
      accountType: user.accountType,
    })
    .from(candidateApiKeys)
    .innerJoin(candidateAccounts, eq(candidateAccounts.id, candidateApiKeys.candidateAccountId))
    .innerJoin(user, eq(user.id, candidateAccounts.userId))
    .where(and(eq(candidateApiKeys.keyHash, sha256(token)), isNull(candidateApiKeys.revokedAt)));
  if (!row || row.erasedAt || row.accountType === "org" || isExpired(row.expiresAt)) {
    throw new AuthError(INVALID_KEY);
  }
  if (!row.emailVerified) throw new AuthError("Verify your email address before continuing.");
  return row;
}

async function candidateFromApiKey(
  token: string,
  scope: ApiScope,
  ip: string,
): Promise<ApiCandidateContext> {
  const row = await loadCandidateKey(token);
  if (!scopeAllows(row.scopes, scope)) throw missingScope(scope);
  await enforceBudget({ keyId: row.keyId, principal: row.userId, tenant: null, ip, scope });
  await assertVaultDelegation({
    ownerType: "candidate",
    ownerId: row.candidateAccountId,
    token,
    wrappedVaultKey: row.wrappedVaultKey,
    scopes: row.scopes,
  });

  void db
    .update(candidateApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(candidateApiKeys.id, row.keyId))
    .catch(() => {});

  return {
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName,
    candidateAccountId: row.candidateAccountId,
    credentialId: row.keyId,
  };
}

export interface ApiKeyDescription {
  kind: "organisation" | "candidate";
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  role?: string;
}

/**
 * Describe the presented key (kind, scopes, expiry) so clients such as the
 * MCP server expose only the tools it can use. Never returns key material.
 * The key must be valid and its vault delegation intact.
 */
export async function describeApiKey(req: NextRequest): Promise<ApiKeyDescription> {
  const token = bearerToken(req);
  if (!token) throw new AuthError(INVALID_KEY);
  const ip = clientIp(req.headers);
  const orgKey = await loadOrgKey(token).catch((error) => {
    if (error instanceof AuthError && error.message === INVALID_KEY) return null;
    throw error;
  });
  if (orgKey) {
    await enforceBudget({ keyId: orgKey.keyId, principal: orgKey.userId, tenant: orgKey.orgId, ip, scope: "roles:read" });
    await assertVaultDelegation({
      ownerType: "organisation",
      ownerId: orgKey.orgId,
      token,
      wrappedVaultKey: orgKey.wrappedVaultKey,
      scopes: orgKey.scopes,
    });
    return {
      kind: "organisation",
      name: orgKey.name,
      prefix: orgKey.prefix,
      scopes: orgKey.scopes,
      expiresAt: orgKey.expiresAt?.toISOString() ?? null,
      role: orgKey.role,
    };
  }
  const candidateKey = await loadCandidateKey(token);
  await enforceBudget({ keyId: candidateKey.keyId, principal: candidateKey.userId, tenant: null, ip, scope: "profile:read" });
  await assertVaultDelegation({
    ownerType: "candidate",
    ownerId: candidateKey.candidateAccountId,
    token,
    wrappedVaultKey: candidateKey.wrappedVaultKey,
    scopes: candidateKey.scopes,
  });
  return {
    kind: "candidate",
    name: candidateKey.name,
    prefix: candidateKey.prefix,
    scopes: candidateKey.scopes,
    expiresAt: candidateKey.expiresAt?.toISOString() ?? null,
  };
}
