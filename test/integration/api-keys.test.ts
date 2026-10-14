import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  apiKeys,
  auditEvents,
  candidateAccounts,
  candidateApiKeys,
  memberships,
  organisations,
  requests,
  user,
  vaultKeys,
} from "@/db/schema";
import { setupMigratedDatabase } from "./harness";

/**
 * Scoped, expiring API keys against a real database, exercised through the
 * exported v1 route handlers with constructed requests. Two organisations,
 * two job seekers, and keys of different scopes, states, and owners.
 */

let stop: () => Promise<void>;
let db: typeof import("@/db").db;
let routes: {
  requests: typeof import("@/app/api/v1/requests/route");
  request: typeof import("@/app/api/v1/requests/[id]/route");
  send: typeof import("@/app/api/v1/requests/[id]/send/route");
  submissions: typeof import("@/app/api/v1/requests/[id]/submissions/route");
  reports: typeof import("@/app/api/v1/reports/recruiter/route");
  profile: typeof import("@/app/api/v1/me/profile/route");
  key: typeof import("@/app/api/v1/me/key/route");
};
let store: typeof import("@/lib/api-key-store");
let rateLimit: typeof import("@/lib/rate-limit");
let vaultCrypto: typeof import("@/lib/vault-crypto");
let vaultStore: typeof import("@/lib/vault-store");
let sha256: (input: string) => string;

const BASE = "http://localhost/api/v1";
const DAY = 86_400_000;

beforeAll(async () => {
  ({ db, stop } = await setupMigratedDatabase());
  routes = {
    requests: await import("@/app/api/v1/requests/route"),
    request: await import("@/app/api/v1/requests/[id]/route"),
    send: await import("@/app/api/v1/requests/[id]/send/route"),
    submissions: await import("@/app/api/v1/requests/[id]/submissions/route"),
    reports: await import("@/app/api/v1/reports/recruiter/route"),
    profile: await import("@/app/api/v1/me/profile/route"),
    key: await import("@/app/api/v1/me/key/route"),
  };
  store = await import("@/lib/api-key-store");
  rateLimit = await import("@/lib/rate-limit");
  vaultCrypto = await import("@/lib/vault-crypto");
  vaultStore = await import("@/lib/vault-store");
  ({ sha256 } = await import("@/lib/crypto"));
});

afterAll(async () => {
  await stop?.();
});

function call(path: string, key: string, init: { method?: string; body?: unknown; ip?: string } = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-forwarded-for": init.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedOrg(role: "owner" | "recruiter" = "owner") {
  const userId = `user-${randomUUID()}`;
  await db.insert(user).values({
    id: userId,
    name: "Org user",
    email: `${userId}@example.org`,
    emailVerified: true,
    accountType: "org",
  });
  const [org] = await db
    .insert(organisations)
    .values({ name: "Org", slug: `org-${randomUUID()}` })
    .returning({ id: organisations.id });
  await db.insert(memberships).values({ orgId: org.id, userId, role });
  const crk = randomBytes(32);
  await vaultStore.insertVaultKey(db, { ownerType: "organisation", ownerId: org.id, crk });
  const [request] = await db
    .insert(requests)
    .values({ orgId: org.id, createdBy: userId, title: "Systems engineer", status: "open" })
    .returning({ id: requests.id });
  return { userId, orgId: org.id, crk, requestId: request.id };
}

async function addMember(orgId: string, role: "recruiter" | "reviewer" | "admin") {
  const userId = `user-${randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "Member", email: `${userId}@example.org`, emailVerified: true, accountType: "org" });
  await db.insert(memberships).values({ orgId, userId, role });
  return userId;
}

async function seedSeeker() {
  const userId = `seeker-${randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "Seeker", email: `${userId}@example.org`, emailVerified: true, accountType: "seeker" });
  const [account] = await db.insert(candidateAccounts).values({ userId }).returning({ id: candidateAccounts.id });
  const crk = randomBytes(32);
  await vaultStore.insertVaultKey(db, { ownerType: "candidate", ownerId: account.id, crk });
  return { userId, candidateAccountId: account.id, crk };
}

function material(crk: Buffer, scopes: string[], expiresAt = new Date(Date.now() + 30 * DAY)) {
  const key = `rv_${randomBytes(32).toString("base64url")}`;
  return {
    key,
    material: {
      name: "test key",
      keyHash: sha256(key),
      prefix: key.slice(0, 11),
      scopes,
      expiresAt,
      vaultKeyId: randomUUID(),
      wrappedVaultKey: vaultCrypto.wrapForCredential(key, crk),
    },
  };
}

async function orgKey(org: { orgId: string; userId: string; crk: Buffer }, scopes: string[], expiresAt?: Date) {
  const { key, material: m } = material(org.crk, scopes, expiresAt);
  const inserted = await store.insertOrgApiKey({ orgId: org.orgId, userId: org.userId }, m);
  if (!inserted.ok) throw new Error(inserted.error);
  return { key, id: inserted.id };
}

async function seekerKey(seeker: { candidateAccountId: string; crk: Buffer }, scopes: string[]) {
  const { key, material: m } = material(seeker.crk, scopes);
  const inserted = await store.insertCandidateApiKey(seeker.candidateAccountId, m);
  if (!inserted.ok) throw new Error(inserted.error);
  return { key, id: inserted.id };
}

const REPORTING = ["reports:read", "roles:read"];

describe("reporting keys", () => {
  it("read reports and roles but cannot create roles, invite, list submissions, or change profiles", async () => {
    const org = await seedOrg();
    const { key } = await orgKey(org, REPORTING);

    expect((await routes.reports.GET(call("/reports/recruiter", key))).status).toBe(200);
    expect((await routes.requests.GET(call("/requests", key))).status).toBe(200);

    const create = await routes.requests.POST(call("/requests", key, { method: "POST", body: { title: "Nope" } }));
    expect(create.status).toBe(403);
    expect((await create.json()).error).toContain("roles:write");

    const invite = await routes.send.POST(
      call(`/requests/${org.requestId}/send`, key, { method: "POST", body: { email: "a@example.org" } }),
      params(org.requestId),
    );
    expect(invite.status).toBe(403);
    const exported = await routes.submissions.GET(call(`/requests/${org.requestId}/submissions`, key), params(org.requestId));
    expect(exported.status).toBe(403);
    expect((await exported.json()).error).toContain("submissions:read");

    // An organisation key is not a job-seeker credential at all.
    const profile = await routes.profile.PATCH(call("/me/profile", key, { method: "PATCH", body: { clearanceLevel: "" } }));
    expect(profile.status).toBe(401);
  });

  it("job-seeker read keys cannot modify the profile", async () => {
    const seeker = await seedSeeker();
    const { key } = await seekerKey(seeker, ["profile:read", "documents:read", "applications:read"]);
    expect((await routes.profile.GET(call("/me/profile", key))).status).toBe(200);
    const patch = await routes.profile.PATCH(call("/me/profile", key, { method: "PATCH", body: { clearanceLevel: "nv1" } }));
    expect(patch.status).toBe(403);
    expect((await patch.json()).error).toContain("profile:write");
  });

  it("describes the key without key material", async () => {
    const org = await seedOrg();
    const { key } = await orgKey(org, REPORTING);
    const res = await routes.key.GET(call("/me/key", key));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatchObject({ kind: "organisation", scopes: REPORTING, role: "owner" });
    expect(JSON.stringify(body)).not.toContain(key);
  });
});

describe("key lifecycle", () => {
  it("rejects expired, revoked, removed-member, erased-seeker, and legacy keys immediately", async () => {
    const org = await seedOrg();
    const expired = await orgKey(org, REPORTING, new Date(Date.now() - 1000));
    expect((await routes.requests.GET(call("/requests", expired.key))).status).toBe(401);

    const revoked = await orgKey(org, REPORTING);
    expect((await routes.requests.GET(call("/requests", revoked.key))).status).toBe(200);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, revoked.id));
    expect((await routes.requests.GET(call("/requests", revoked.key))).status).toBe(401);

    const memberId = await addMember(org.orgId, "recruiter");
    const member = await orgKey({ ...org, userId: memberId }, REPORTING);
    expect((await routes.requests.GET(call("/requests", member.key))).status).toBe(200);
    await db.delete(memberships).where(and(eq(memberships.orgId, org.orgId), eq(memberships.userId, memberId)));
    expect((await routes.requests.GET(call("/requests", member.key))).status).toBe(401);

    const seeker = await seedSeeker();
    const seekerRead = await seekerKey(seeker, ["profile:read"]);
    expect((await routes.profile.GET(call("/me/profile", seekerRead.key))).status).toBe(200);
    await db.update(user).set({ erasedAt: new Date() }).where(eq(user.id, seeker.userId));
    expect((await routes.profile.GET(call("/me/profile", seekerRead.key))).status).toBe(401);

    // Migration policy: legacy:full keys without vault delegation must be replaced.
    const legacyToken = `rv_${randomBytes(32).toString("base64url")}`;
    await db.insert(apiKeys).values({
      orgId: org.orgId,
      userId: org.userId,
      name: "legacy",
      keyHash: sha256(legacyToken),
      prefix: legacyToken.slice(0, 11),
      scopes: ["legacy:full"],
      expiresAt: new Date(Date.now() + DAY),
    });
    const legacy = await routes.requests.GET(call("/requests", legacyToken));
    expect(legacy.status).toBe(401);
    expect((await legacy.json()).error).toMatch(/must be replaced/);

    // An unknown or malformed bearer is rejected, never ignored.
    expect((await routes.requests.GET(call("/requests", "rv_not-a-real-key"))).status).toBe(401);
    expect((await routes.requests.GET(call("/requests", "Basic abc"))).status).toBe(401);
  });

  it("holds a key to the creator's live role", async () => {
    const org = await seedOrg();
    const memberId = await addMember(org.orgId, "recruiter");
    const writer = await orgKey({ ...org, userId: memberId }, ["roles:write", "roles:read"]);
    const created = await routes.requests.POST(call("/requests", writer.key, { method: "POST", body: { title: "Analyst" } }));
    expect(created.status).toBe(201);

    // The scoped API use is audited with the credential id and the actor.
    const audited = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "api.roles:write"), eq(auditEvents.targetId, writer.id)));
    expect(audited).toHaveLength(1);
    expect(audited[0].actorId).toBe(memberId);

    await db
      .update(memberships)
      .set({ role: "reviewer" })
      .where(and(eq(memberships.orgId, org.orgId), eq(memberships.userId, memberId)));
    const demoted = await routes.requests.POST(call("/requests", writer.key, { method: "POST", body: { title: "Analyst 2" } }));
    expect(demoted.status).toBe(403);
  });

  it("cannot bypass an unenrolled or shredded vault", async () => {
    const org = await seedOrg();
    const { key } = await orgKey(org, REPORTING);
    await db
      .update(vaultKeys)
      .set({ privateKeyWrapped: null })
      .where(and(eq(vaultKeys.ownerType, "organisation"), eq(vaultKeys.ownerId, org.orgId)));
    const res = await routes.requests.GET(call("/requests", key));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Encryption enrollment/);
  });

  it("rotates atomically: new key works, old key stops", async () => {
    const org = await seedOrg();
    const old = await orgKey(org, REPORTING);
    const { key: newKey, material: m } = material(org.crk, REPORTING);
    const rotated = await store.insertOrgApiKey({ orgId: org.orgId, userId: org.userId }, m, old.id);
    expect(rotated.ok).toBe(true);
    expect((await routes.requests.GET(call("/requests", newKey))).status).toBe(200);
    expect((await routes.requests.GET(call("/requests", old.key))).status).toBe(401);
    // Rotating an already revoked key does nothing.
    const again = await store.insertOrgApiKey({ orgId: org.orgId, userId: org.userId }, material(org.crk, REPORTING).material, old.id);
    expect(again.ok).toBe(false);
  });

  it("respects the per-user cap under concurrent creation, and the org cap", async () => {
    const org = await seedOrg();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        store.insertOrgApiKey({ orgId: org.orgId, userId: org.userId }, material(org.crk, REPORTING).material),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);

    for (let i = 0; i < 4; i += 1) {
      const memberId = await addMember(org.orgId, "admin");
      for (let j = 0; j < 10; j += 1) {
        const r = await store.insertOrgApiKey({ orgId: org.orgId, userId: memberId }, material(org.crk, REPORTING).material);
        expect(r.ok).toBe(true);
      }
    }
    const extra = await addMember(org.orgId, "admin");
    const over = await store.insertOrgApiKey({ orgId: org.orgId, userId: extra }, material(org.crk, REPORTING).material);
    expect(over).toMatchObject({ ok: false });

    const seeker = await seedSeeker();
    const seekerResults = await Promise.all(
      Array.from({ length: 14 }, () =>
        store.insertCandidateApiKey(seeker.candidateAccountId, material(seeker.crk, ["profile:read"]).material),
      ),
    );
    expect(seekerResults.filter((r) => r.ok)).toHaveLength(10);
    const active = await db
      .select({ id: candidateApiKeys.id })
      .from(candidateApiKeys)
      .where(eq(candidateApiKeys.candidateAccountId, seeker.candidateAccountId));
    expect(active).toHaveLength(10);
  });
});

describe("tenant and owner isolation", () => {
  it("never exposes another organisation's roles and rejects recruiter/seeker key swaps", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const keyA = await orgKey(orgA, REPORTING);

    const foreign = await routes.request.GET(call(`/requests/${orgB.requestId}`, keyA.key), params(orgB.requestId));
    expect(foreign.status).toBe(404);
    const list = await (await routes.requests.GET(call("/requests", keyA.key))).json();
    const ids = list.requests.map((r: { id: string }) => r.id);
    expect(ids).toContain(orgA.requestId);
    expect(ids).not.toContain(orgB.requestId);

    const exporter = await orgKey(orgA, ["submissions:read"]);
    const foreignSubmissions = await routes.submissions.GET(
      call(`/requests/${orgB.requestId}/submissions`, exporter.key),
      params(orgB.requestId),
    );
    expect(foreignSubmissions.status).toBe(404);
    const ownSubmissions = await routes.submissions.GET(
      call(`/requests/${orgA.requestId}/submissions`, exporter.key),
      params(orgA.requestId),
    );
    expect(ownSubmissions.status).toBe(200);

    const seekerA = await seedSeeker();
    const seekerB = await seedSeeker();
    const seekerKeyA = await seekerKey(seekerA, ["profile:read", "profile:write"]);
    expect((await routes.requests.GET(call("/requests", seekerKeyA.key))).status).toBe(401);
    expect((await routes.profile.PATCH(call("/me/profile", seekerKeyA.key, { method: "PATCH", body: { clearanceLevel: "nv1", discoverable: true } }))).status).toBe(200);
    const seekerKeyB = await seekerKey(seekerB, ["profile:read"]);
    const profileB = await (await routes.profile.GET(call("/me/profile", seekerKeyB.key))).json();
    expect(profileB.profile.clearanceLevel).toBeNull();
  });
});

describe("shared request budgets", () => {
  it("admits exactly the budget under concurrency and reports the remaining window", async () => {
    const key = `test-bucket:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => rateLimit.consumeRateLimit(key, 10, 5_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    for (const r of results.filter((r) => !r.allowed)) {
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(r.retryAfterSeconds).toBeLessThanOrEqual(5);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const later = await rateLimit.consumeRateLimit(key, 10, 5_000);
    expect(later.allowed).toBe(false);
    expect(later.retryAfterSeconds).toBeLessThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    expect((await rateLimit.consumeRateLimit(key, 10, 5_000)).allowed).toBe(true);
  });

  it("returns 429 with Retry-After once a key's route budget is spent, across concurrent requests", async () => {
    const org = await seedOrg();
    const { key } = await orgKey(org, ["invitations:send"]);
    const responses = await Promise.all(
      Array.from({ length: 36 }, () =>
        routes.send.POST(
          call(`/requests/${org.requestId}/send`, key, { method: "POST", body: {} }),
          params(org.requestId),
        ),
      ),
    );
    const limited = responses.filter((r) => r.status === 429);
    expect(limited).toHaveLength(6);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(30);
    for (const r of limited) {
      const retryAfter = Number(r.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(JSON.stringify(await r.json())).not.toMatch(/rv_|scope|expires/);
    }
  });

  it("prunes idle windows", async () => {
    expect(await rateLimit.pruneRateLimits(new Date(Date.now() + 2 * DAY))).toBeGreaterThan(0);
  });
});
