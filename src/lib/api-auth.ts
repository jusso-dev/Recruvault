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
import { isExpired, scopeAllows, routeBudget, type ApiScope } from "@/lib/api-scopes";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { openCredentialWrap, verifierMatches } from "@/lib/vault-crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/api/http";

export const API_KEY_PREFIX = "rv_";

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer?.startsWith(API_KEY_PREFIX)) {
    throw new AuthError("Invalid or revoked API key.");
  }
  return bearer;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function enforceBudget(keyId: string, ip: string, scope: ApiScope) {
  const budget = routeBudget(scope);
  const [byKey, byIp] = await Promise.all([
    checkRateLimit(`api:${keyId}:${scope}`, budget.max, budget.windowMs),
    checkRateLimit(`api-ip:${ip}:${scope}`, budget.max * 2, budget.windowMs),
  ]);
  if (!byKey || !byIp) throw new RateLimitError(Math.ceil(budget.windowMs / 1000));
}

async function assertVaultDelegation(opts: {
  ownerType: "organisation" | "candidate";
  ownerId: string;
  token: string;
  wrappedVaultKey: string | null;
}) {
  const vault = await activeVault(opts.ownerType, opts.ownerId);
  if (!vault || !vault.privateKeyWrapped) {
    throw new AuthError("Encryption enrollment is required.");
  }
  if (!opts.wrappedVaultKey) {
    throw new AuthError("This API key was issued before encryption enrollment. Create a new key.");
  }
  try {
    const crk = openCredentialWrap(opts.token, opts.wrappedVaultKey);
    if (!verifierMatches(crk, opts.ownerType, opts.ownerId, vault.verifier)) {
      throw new AuthError("Invalid or revoked API key.");
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Invalid or revoked API key.");
  }
}

export async function resolveOrgContext(
  req: NextRequest,
  permission?: Permission,
  scope?: ApiScope,
): Promise<OrgContext> {
  const bearer = bearerToken(req);
  if (bearer) {
    const ctx = await contextFromApiKey(bearer, scope, clientIp(req));
    if (permission && !can(ctx.role, permission)) {
      throw new AuthError(`Your role does not allow this action (${permission}).`);
    }
    return ctx;
  }
  const ctx = await requireOrgUser(permission);
  if (!(await activeVault("organisation", ctx.orgId)) || !(await readUnlockedCustomerKey("organisation", ctx.orgId))) {
    throw new AuthError("Encryption enrollment is required.");
  }
  if (scope) await enforceBudget(ctx.userId, clientIp(req), scope);
  return ctx;
}

async function contextFromApiKey(token: string, scope: ApiScope | undefined, ip: string): Promise<OrgContext> {
  const keyHash = sha256(token);
  const [row] = await db
    .select({
      keyId: apiKeys.id,
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
    })
    .from(apiKeys)
    .innerJoin(
      memberships,
      and(eq(memberships.userId, apiKeys.userId), eq(memberships.orgId, apiKeys.orgId)),
    )
    .innerJoin(organisations, eq(organisations.id, apiKeys.orgId))
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));

  if (!row || isExpired(row.expiresAt)) throw new AuthError("Invalid or revoked API key.");
  if (!row.emailVerified) throw new AuthError("Verify your email address before continuing.");
  if (scope && !scopeAllows(row.scopes, scope)) {
    throw new AuthError("This API key does not include the required scope.");
  }
  if (scope) await enforceBudget(row.keyId, ip, scope);
  await assertVaultDelegation({
    ownerType: "organisation",
    ownerId: row.orgId,
    token,
    wrappedVaultKey: row.wrappedVaultKey,
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
  };
}

export async function resolveCandidateContext(
  req: NextRequest,
  scope?: ApiScope,
): Promise<CandidateContext> {
  const bearer = bearerToken(req);
  if (bearer) return candidateFromApiKey(bearer, scope, clientIp(req));
  const ctx = await requireCandidate();
  if (
    !(await activeVault("candidate", ctx.candidateAccountId)) ||
    !(await readUnlockedCustomerKey("candidate", ctx.candidateAccountId))
  ) {
    throw new AuthError("Encryption enrollment is required.");
  }
  if (scope) await enforceBudget(ctx.userId, clientIp(req), scope);
  return ctx;
}

async function candidateFromApiKey(
  token: string,
  scope: ApiScope | undefined,
  ip: string,
): Promise<CandidateContext> {
  const keyHash = sha256(token);
  const [row] = await db
    .select({
      keyId: candidateApiKeys.id,
      candidateAccountId: candidateApiKeys.candidateAccountId,
      scopes: candidateApiKeys.scopes,
      expiresAt: candidateApiKeys.expiresAt,
      wrappedVaultKey: candidateApiKeys.wrappedVaultKey,
      userId: candidateAccounts.userId,
      userEmail: user.email,
      userName: user.name,
      erasedAt: user.erasedAt,
      emailVerified: user.emailVerified,
    })
    .from(candidateApiKeys)
    .innerJoin(candidateAccounts, eq(candidateAccounts.id, candidateApiKeys.candidateAccountId))
    .innerJoin(user, eq(user.id, candidateAccounts.userId))
    .where(and(eq(candidateApiKeys.keyHash, keyHash), isNull(candidateApiKeys.revokedAt)));

  if (!row || row.erasedAt || isExpired(row.expiresAt)) throw new AuthError("Invalid or revoked API key.");
  if (!row.emailVerified) throw new AuthError("Verify your email address before continuing.");
  if (scope && !scopeAllows(row.scopes, scope)) {
    throw new AuthError("This API key does not include the required scope.");
  }
  if (scope) await enforceBudget(row.keyId, ip, scope);
  await assertVaultDelegation({
    ownerType: "candidate",
    ownerId: row.candidateAccountId,
    token,
    wrappedVaultKey: row.wrappedVaultKey,
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
  };
}
