import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import * as rows from "./security-db";
import { waitForEmail } from "./email-helpers";
import {
  callAction,
  clientWithCookie,
  cookieHeaderOf,
  denied,
  expectNoLeak,
  loadActionRefs,
  newClient,
  newCustomerKey,
  sessionCookie,
  signIn,
  signUp,
  verifyByEmail,
  type ActionArgs,
  type ActionOutcome,
  type ActionRef,
} from "./security-helpers";

/**
 * Release-gating security matrix (#35): every principal and credential
 * against every sensitive target, by direct HTTP request. Server Actions are
 * POSTed with their action id, REST routes get raw bearer keys, and document,
 * export, and link routes get the cookies a real browser would hold. Denials
 * are asserted on status and body, and each allowed path is exercised so a
 * denial cannot pass vacuously. docs/security-test-matrix.md maps each cell to
 * a test here or in test/integration.
 */

test.describe.configure({ mode: "serial", timeout: 600_000 });

// Synthetic, per-run values. None of them is printed or written to artifacts.
const RUN = randomBytes(4).toString("hex");
const MARK = {
  evidence: `MATRIX-EVIDENCE-${RUN}`,
  field: `MATRIX-FIELD-${RUN}`,
  walletA: `MATRIX-WALLET-A-${RUN}`,
  walletB: `MATRIX-WALLET-B-${RUN}`,
  walletItem: `MATRIX-ITEM-${RUN}`,
  jd: `MATRIX-JD-${RUN}`,
};
const KEYS = { orgA: newCustomerKey(), orgB: newCustomerKey(), seekerA: newCustomerKey(), seekerB: newCustomerKey() };
const BOOTSTRAP_TOKEN = "e2e-bootstrap-token-not-for-production";
// Mirrors RESEND_WEBHOOK_SECRET in playwright.config.ts. Test-only.
const WEBHOOK_SECRET = "whsec_" + Buffer.from("e2e-webhook-secret-not-for-production").toString("base64");

// BetterAuth stores addresses lower-cased.
const email = (label: string) => `sm-${label}-${RUN}@e2e.recruvault.test`.toLowerCase();
const ORG_SCOPES = ["reports:read", "roles:read", "roles:write", "jd:write", "invitations:send", "submissions:read", "match:read"] as const;
const SEEKER_SCOPES = ["profile:read", "profile:write", "documents:read", "applications:read"] as const;

type Label =
  | "anonymous"
  | "forgedCookie"
  | "ownerAExpired"
  | "ownerARevoked"
  | "seekerAExpired"
  | "seekerARevoked"
  | "unverifiedOrg"
  | "orglessOrg"
  | "ownerA"
  | "ownerALocked"
  | "adminA"
  | "recruiterA"
  | "reviewerA"
  | "complianceA"
  | "ownerB"
  | "seekerA"
  | "seekerALocked"
  | "seekerB"
  | "seekerUnenrolled";

const P = new Map<Label, APIRequestContext>();
const who = (label: Label) => {
  const client = P.get(label);
  if (!client) throw new Error(`Principal ${label} was not created.`);
  return client;
};

// World state, filled in by the first test.
const w = {
  refs: new Map<string, ActionRef>(),
  orgA: "",
  orgB: "",
  platformOrg: "",
  reqA: "",
  reqB: "",
  templateA: "",
  subA: "",
  docA: "",
  jdA: "",
  tokenA: "",
  tokenForward: "",
  tokenRevoked: "",
  tokenExpired: "",
  tokenLockout: "",
  atForwardId: "",
  memReviewerA: "",
  reviewerAId: "",
  recruiterAId: "",
  ownerBId: "",
  walletDocA: "",
  walletDocB: "",
  walletItemA: "",
  orgKeys: new Map<string, string>(),
  orgKeyIds: new Map<string, string>(),
  seekerKeys: new Map<string, string>(),
  seekerKeyIds: new Map<string, string>(),
  orgBKey: "",
  linkTokens: [] as string[],
};

/** Everything that must never appear in a response the caller is not entitled to. */
function protectedValues() {
  return [
    ...Object.values(MARK),
    ...Object.values(KEYS),
    ...w.orgKeys.values(),
    ...w.seekerKeys.values(),
    w.orgBKey,
  ].filter(Boolean);
}

function act(name: string) {
  const ref = w.refs.get(name);
  if (ref) return ref;
  // See the inventory test: after bootstrap, /setup is unreachable regardless of the id.
  if (name === "completePlatformSetup") return { id: "0".repeat(42), exportedName: name, filename: "src/actions/setup.ts", route: "/setup" };
  throw new Error(`Server Action ${name} was not found in the build manifests.`);
}

/** Every export of every "use server" module under src/: the attack surface. */
function serverActionExports() {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) {
        const source = readFileSync(full, "utf8");
        if (!/^\s*["']use server["']/m.test(source)) continue;
        for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.push(match[1]);
        for (const match of source.matchAll(/^export\s+const\s+(\w+)/gm)) names.push(match[1]);
      }
    }
  };
  walk("src");
  return [...new Set(names)].sort();
}

async function run(label: Label, name: string, input: ActionArgs, params: Record<string, string> = {}) {
  return callAction(who(label), act(name), input, params);
}

async function runOk(label: Label, name: string, input: ActionArgs, params: Record<string, string> = {}) {
  const outcome = await run(label, name, input, params);
  expect(denied(outcome), `${name} as ${label}: ${outcome.result?.error ?? outcome.thrown ?? outcome.status}`).toBe(false);
  return outcome;
}

const keyForm = (key: string) => ({ keyMode: "import", encryptionKey: key, encryptionKeyConfirm: key, keyBackupAck: "yes" });

// A real one-page PDF (view-only renders are watermarked, which parses it),
// with the marker in a trailing comment so it is findable in raw bytes.
let basePdf = Buffer.alloc(0);
const pdf = (marker: string, name = "matrix.pdf") => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.concat([basePdf, Buffer.from(`\n% ${marker}\n`, "latin1")]),
});

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

async function orgAccount(label: string) {
  await rows.resetRateLimits();
  const after = Date.now();
  const principal = await signUp(label, email(label), "org");
  await verifyByEmail(principal, after);
  return principal.client;
}

async function seekerAccount(label: string, key?: string) {
  await rows.resetRateLimits();
  const after = Date.now();
  const principal = await signUp(label, email(label), "seeker");
  await verifyByEmail(principal, after);
  // The seeker layout creates the candidate account on first visit.
  await principal.client.get("/overview", { maxRedirects: 0 });
  if (key) {
    const client = principal.client;
    P.set(label as Label, client);
    await runOk(label as Label, "enrollVault", { form: keyForm(key) });
  }
  return principal.client;
}

async function secondSession(label: string, account: string) {
  await rows.resetRateLimits();
  return (await signIn(label, email(account))).client;
}

/** Compile every page so the development manifests list every action. */
async function warmPages() {
  const client = await clientWithCookie("better-auth.session_token=warm.up");
  const pages = [
    "/",
    "/setup",
    "/onboarding",
    "/dashboard",
    "/dashboard/settings",
    "/dashboard/integrations",
    "/dashboard/job-alerts",
    "/dashboard/audit",
    "/dashboard/requests/new",
    `/dashboard/requests/${randomUUID()}`,
    `/dashboard/requests/${randomUUID()}/submissions/${randomUUID()}`,
    "/overview",
    "/documents",
    "/wallet",
    "/roles",
    "/integrations",
    "/vault/enroll",
    "/vault/unlock",
    "/vault/rotate",
    "/vault/waiting",
    "/r/warm",
    "/r/warm/respond",
    "/r/warm/done",
  ];
  for (const page of pages) await client.get(page, { maxRedirects: 0 });
  await client.dispose();
}

async function ensureBootstrapped() {
  const anon = await newClient();
  const setup = await anon.get("/setup", { maxRedirects: 0 });
  if (setup.status() === 200) {
    const owner = await orgAccount("platform");
    const refs = loadActionRefs();
    const ref = refs.get("completePlatformSetup");
    if (!ref) throw new Error("completePlatformSetup was not compiled.");
    const done = await callAction(owner, ref, {
      form: { organisationName: "E2E Platform Bootstrap", bootstrapToken: BOOTSTRAP_TOKEN, ...keyForm(newCustomerKey()) },
    });
    expect(done.result?.ok).toBe(true);
  }
  await anon.dispose();
}

async function invitation(label: Label, requestId: string, recipient: string) {
  const after = Date.now();
  await runOk(label, "sendRequest", { form: { requestId, recipientEmail: recipient } });
  const mail = await waitForEmail({ to: recipient, subject: /has requested information securely/, after });
  const token = new URL(mail.ctaUrl!).pathname.split("/")[2];
  w.linkTokens.push(token);
  return token;
}

async function otpFor(client: APIRequestContext, token: string, recipient: string) {
  await rows.resetRateLimits();
  const after = Date.now();
  const sent = await callAction(client, act("requestOtp"), { args: [token] }, { token });
  expect(sent.result?.ok, sent.result?.error).toBe(true);
  const mail = await waitForEmail({ to: recipient, subject: "Your Recruvault verification code", after });
  return mail.code!;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

interface Route {
  name: string;
  kind: "org" | "seeker";
  scope: string;
  call: (client: APIRequestContext, headers: Record<string, string>) => Promise<APIResponse>;
  /** Mutating routes are exercised with keys, not repeated for every session. */
  mutates?: boolean;
}

function routes(): Route[] {
  return [
    { name: "GET /api/v1/requests", kind: "org", scope: "roles:read", call: (c, h) => c.get("/api/v1/requests", { headers: h }) },
    { name: "GET /api/v1/requests/:id", kind: "org", scope: "roles:read", call: (c, h) => c.get(`/api/v1/requests/${w.reqA}`, { headers: h }) },
    {
      name: "POST /api/v1/requests",
      kind: "org",
      scope: "roles:write",
      mutates: true,
      call: (c, h) => c.post("/api/v1/requests", { headers: h, data: { title: `Matrix API role ${RUN}`, fieldKeys: ["resume"] } }),
    },
    {
      name: "POST /api/v1/requests/:id/jd",
      kind: "org",
      scope: "jd:write",
      mutates: true,
      call: (c, h) => c.post(`/api/v1/requests/${w.reqA}/jd`, { headers: h, multipart: { jd: pdf(MARK.jd, "jd.pdf") } }),
    },
    {
      name: "POST /api/v1/requests/:id/send",
      kind: "org",
      scope: "invitations:send",
      mutates: true,
      call: (c, h) => c.post(`/api/v1/requests/${w.reqA}/send`, { headers: h, data: { email: email("api-invitee") } }),
    },
    { name: "GET /api/v1/requests/:id/submissions", kind: "org", scope: "submissions:read", call: (c, h) => c.get(`/api/v1/requests/${w.reqA}/submissions`, { headers: h }) },
    { name: "GET /api/v1/reports/recruiter", kind: "org", scope: "reports:read", call: (c, h) => c.get("/api/v1/reports/recruiter", { headers: h }) },
    { name: "POST /api/v1/match", kind: "org", scope: "match:read", call: (c, h) => c.post("/api/v1/match", { headers: h, data: { skills: ["matrix"] } }) },
    { name: "GET /api/v1/me/profile", kind: "seeker", scope: "profile:read", call: (c, h) => c.get("/api/v1/me/profile", { headers: h }) },
    {
      name: "PATCH /api/v1/me/profile",
      kind: "seeker",
      scope: "profile:write",
      mutates: true,
      call: (c, h) => c.patch("/api/v1/me/profile", { headers: h, data: { discoverable: false, clearanceLevel: "", skills: ["matrix"] } }),
    },
    { name: "GET /api/v1/me/documents", kind: "seeker", scope: "documents:read", call: (c, h) => c.get("/api/v1/me/documents", { headers: h }) },
    { name: "GET /api/v1/me/applications", kind: "seeker", scope: "applications:read", call: (c, h) => c.get("/api/v1/me/applications", { headers: h }) },
  ];
}

async function expectDeniedResponse(response: APIResponse, statuses: number[], context: string) {
  const body = await response.text();
  expect(statuses, `${context}: HTTP ${response.status()}`).toContain(response.status());
  expectNoLeak(body, protectedValues(), context);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("security matrix", () => {
  test.afterAll(async () => {
    for (const client of P.values()) await client.dispose();
  });

  test("builds every principal and fixture through direct requests", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    basePdf = Buffer.from(await document.save({ useObjectStreams: false }));
    await ensureBootstrapped();
    await warmPages();
    w.refs = loadActionRefs();
    P.set("anonymous", await newClient());
    P.set("forgedCookie", await clientWithCookie("better-auth.session_token=forged.c2lnbmF0dXJl"));

    // Organisation A: owner plus one member per assignable role.
    P.set("ownerA", await orgAccount("ownera"));
    const createdA = await runOk("ownerA", "createOrganisation", { form: { name: `Matrix Org A ${RUN}`, ...keyForm(KEYS.orgA) } });
    w.orgA = createdA.result!.id!;
    for (const [label, role] of [["adminA", "admin"], ["recruiterA", "recruiter"], ["reviewerA", "reviewer"], ["complianceA", "compliance"]] as const) {
      P.set(label, await orgAccount(label.toLowerCase()));
      await runOk("ownerA", "addMember", { form: { email: email(label.toLowerCase()), role } });
      await runOk(label, "unlockVault", { form: { encryptionKey: KEYS.orgA } });
    }
    w.memReviewerA = await rows.membershipId(email("reviewera"));
    w.reviewerAId = await rows.userId(email("reviewera"));
    w.recruiterAId = await rows.userId(email("recruitera"));

    // Organisation B: a second tenant with its own key.
    P.set("ownerB", await orgAccount("ownerb"));
    const createdB = await runOk("ownerB", "createOrganisation", { form: { name: `Matrix Org B ${RUN}`, ...keyForm(KEYS.orgB) } });
    w.orgB = createdB.result!.id!;
    w.ownerBId = await rows.userId(email("ownerb"));
    w.platformOrg = (await rows.query<{ org_id: string }>(
      `select m.org_id from platform_bootstrap p join memberships m on m.user_id = p.consumed_by_user_id`,
    ))[0]?.org_id ?? "";
    expect([w.orgA, w.orgB]).not.toContain(w.platformOrg);

    // Organisation accounts that must not reach any workspace.
    P.set("orglessOrg", await orgAccount("orgless"));
    await rows.resetRateLimits();
    P.set("unverifiedOrg", (await signUp("unverified", email("unverified"), "org")).client);

    // Seekers: two enrolled strangers and one that never saved a key.
    P.set("seekerA", await seekerAccount("seekerA", KEYS.seekerA));
    P.set("seekerB", await seekerAccount("seekerB", KEYS.seekerB));
    P.set("seekerUnenrolled", await seekerAccount("seekerUnenrolled"));

    // Session states: a second sign-in holds no customer key until unlocked.
    P.set("ownerALocked", await secondSession("ownerALocked", "ownera"));
    P.set("seekerALocked", await secondSession("seekerALocked", "seekerA"));
    const expiredOwner = await secondSession("ownerAExpired", "ownera");
    await callAction(expiredOwner, act("unlockVault"), { form: { encryptionKey: KEYS.orgA } });
    await rows.expireSession(await sessionCookie(expiredOwner));
    P.set("ownerAExpired", expiredOwner);
    const expiredSeeker = await secondSession("seekerAExpired", "seekerA");
    await rows.expireSession(await sessionCookie(expiredSeeker));
    P.set("seekerAExpired", expiredSeeker);
    for (const [label, account] of [["ownerARevoked", "ownera"], ["seekerARevoked", "seekerA"]] as const) {
      const session = await secondSession(label, account);
      const cookies = await cookieHeaderOf(session);
      expect((await session.post("/api/auth/sign-out", { data: {} })).ok()).toBe(true);
      await session.dispose();
      P.set(label, await clientWithCookie(cookies));
    }

    // Roles, one saved as a template.
    const roleA = await runOk("ownerA", "createRequest", {
      form: { title: `Matrix role A ${RUN}`, fields: ["resume", "clearance_id"], saveAsTemplate: "on", listed: "on" },
    });
    w.reqA = roleA.result!.id!;
    w.templateA = (await rows.templateId(w.orgA))!;
    const roleB = await runOk("ownerB", "createRequest", { form: { title: `Matrix role B ${RUN}`, fields: ["resume"] } });
    w.reqB = roleB.result!.id!;

    // Secure links: seekerA applies; the others feed the link-state tests.
    w.tokenA = await invitation("ownerA", w.reqA, email("seekerA"));
    w.tokenForward = await invitation("ownerA", w.reqA, email("forward"));
    w.tokenRevoked = await invitation("ownerA", w.reqA, email("revoked"));
    w.tokenExpired = await invitation("ownerA", w.reqA, email("expired"));
    w.tokenLockout = await invitation("ownerA", w.reqA, email("lockout"));
    w.atForwardId = (await rows.accessToken(w.tokenForward)).id;

    const code = await otpFor(who("seekerA"), w.tokenA, email("seekerA"));
    await runOk("seekerA", "verifyOtp", { args: [w.tokenA, code] }, { token: w.tokenA });
    const fields = await rows.requestFields(w.reqA);
    const answers: Record<string, ReturnType<typeof pdf> | string> = { consent: "on" };
    for (const field of fields) {
      answers[`field_${field.id}`] = field.type === "file_upload" ? pdf(MARK.evidence, "evidence.pdf") : MARK.field;
    }
    await runOk("seekerA", "submitResponse", { form: answers }, { token: w.tokenA });
    w.subA = (await rows.submissionForToken((await rows.accessToken(w.tokenA)).id)).id;
    w.docA = await rows.submissionDocumentId(w.subA);
    await rows.waitForCleanScan("documents", w.docA);

    // Career documents and a credential, one per seeker.
    await runOk("seekerA", "uploadWalletDocument", { form: { kind: "resume", file: pdf(MARK.walletA, "a.pdf") } });
    await runOk("seekerB", "uploadWalletDocument", { form: { kind: "resume", file: pdf(MARK.walletB, "b.pdf") } });
    await runOk("seekerA", "upsertWalletItem", { form: { type: "clearance_id", value: MARK.walletItem } });
    [w.walletDocA] = await rows.walletDocumentIds(email("seekerA"));
    [w.walletDocB] = await rows.walletDocumentIds(email("seekerB"));
    [w.walletItemA] = await rows.walletItemIds(email("seekerA"));
    await rows.waitForCleanScan("wallet_documents", w.walletDocA);
    await rows.waitForCleanScan("wallet_documents", w.walletDocB);

    // One API key per scope, plus an all-scope key for each owner and seeker.
    for (const scope of [...ORG_SCOPES, "all"]) {
      const name = `matrix-${scope}-${RUN}`;
      const created = await runOk("ownerA", "createApiKey", {
        form: { name, scopes: scope === "all" ? [...ORG_SCOPES] : [scope], ttlDays: "30" },
      });
      w.orgKeys.set(scope, created.result!.key as string);
      w.orgKeyIds.set(scope, created.result!.id!);
    }
    for (const scope of [...SEEKER_SCOPES, "all"]) {
      const name = `matrix-seeker-${scope}-${RUN}`;
      const created = await runOk("seekerA", "createCandidateApiKey", {
        form: { name, scopes: scope === "all" ? [...SEEKER_SCOPES] : [scope], ttlDays: "30" },
      });
      w.seekerKeys.set(scope, created.result!.key as string);
      w.seekerKeyIds.set(scope, created.result!.id!);
    }
    w.orgBKey = (await runOk("ownerB", "createApiKey", { form: { name: `matrix-b-${RUN}`, scopes: [...ORG_SCOPES], ttlDays: "30" } })).result!.key as string;
    for (const name of ["expired", "revoked"]) {
      const created = await runOk("ownerA", "createApiKey", { form: { name: `matrix-${name}-${RUN}`, scopes: ["roles:read"], ttlDays: "30" } });
      w.orgKeys.set(name, created.result!.key as string);
    }
    await rows.expireApiKey(`matrix-expired-${RUN}`);
    await runOk("ownerA", "revokeApiKey", { form: { keyId: await rows.apiKeyId(`matrix-revoked-${RUN}`) } });
  });

  test("the matrix names every Server Action in the source and the build", async () => {
    const covered = [...new Set(actionCells().map((cell) => cell.action))].sort();
    expect(serverActionExports()).toEqual(covered);
    // Each one is reachable by id. Setup is the exception once bootstrapped:
    // the proxy redirects every /setup request, so it has no live endpoint.
    const exposed = new Set(w.refs.keys());
    expect(covered.filter((name) => !exposed.has(name) && name !== "completePlatformSetup")).toEqual([]);
  });

  test("every Server Action refuses every principal without the right", async () => {
    const failures: string[] = [];
    for (const cell of actionCells()) {
      const before = cell.state ? await cell.state() : undefined;
      for (const label of cell.deny) {
        const outcome = await run(label, cell.action, cell.input(label), cell.params?.() ?? {});
        const ok = cell.refused ? cell.refused(outcome) : denied(outcome) || isProxyRedirect(outcome);
        if (!ok) failures.push(`${cell.action} as ${label}: ${outcome.status} ${JSON.stringify(outcome.result)}`);
        if (cell.reason && outcome.result?.ok !== true && !isProxyRedirect(outcome)) {
          const message = outcome.result?.error ?? outcome.thrown ?? "";
          if (!cell.reason.test(message)) failures.push(`${cell.action} as ${label} denied for the wrong reason: ${message}`);
        }
        try {
          expectNoLeak(outcome.body, protectedValues(), `${cell.action} as ${label}`);
        } catch (error) {
          failures.push((error as Error).message);
        }
      }
      if (cell.state) {
        const after = await cell.state();
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          failures.push(`${cell.action}: a denied call changed state (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("REST v1: each scoped key reaches only its own route", async () => {
    const failures: string[] = [];
    const client = who("anonymous");
    for (const route of routes()) {
      for (const [scope, key] of [...w.orgKeys, ...w.seekerKeys]) {
        if (scope === "expired" || scope === "revoked") continue;
        const isSeekerKey = [...w.seekerKeys.values()].includes(key);
        const kindMatches = isSeekerKey === (route.kind === "seeker");
        const allowed = kindMatches && (scope === "all" || scope === route.scope);
        const response = await route.call(client, bearer(key));
        const status = response.status();
        const body = await response.text();
        if (allowed && status >= 300) failures.push(`${route.name} with ${scope}: expected success, got ${status} ${body.slice(0, 120)}`);
        if (!allowed && ![401, 403].includes(status)) failures.push(`${route.name} with ${isSeekerKey ? "seeker " : ""}${scope}: expected 401/403, got ${status}`);
        if (!allowed) {
          try {
            expectNoLeak(body, [...protectedValues(), `Matrix role A ${RUN}`], route.name);
          } catch (error) {
            failures.push((error as Error).message);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    w.jdA = (await rows.requestRow(w.reqA)).jd_document_id!;
    expect(w.jdA).toBeTruthy();
  });

  test("REST v1: unusable keys and unauthorised sessions are refused on every route", async () => {
    const anon = who("anonymous");
    const badKeys: [string, Record<string, string>][] = [
      ["expired key", bearer(w.orgKeys.get("expired")!)],
      ["revoked key", bearer(w.orgKeys.get("revoked")!)],
      ["unknown rv_ key", bearer(`rv_${randomBytes(32).toString("base64url")}`)],
      ["key without the rv_ prefix", bearer(randomBytes(24).toString("hex"))],
      ["non-bearer scheme", { authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` }],
      ["empty bearer", { authorization: "Bearer " }],
    ];
    for (const route of routes()) {
      for (const [label, headers] of badKeys) {
        await expectDeniedResponse(await route.call(anon, headers), [401], `${route.name} with ${label}`);
      }
      // A presented credential is never ignored in favour of the cookie.
      await expectDeniedResponse(await route.call(who("ownerA"), bearer(w.orgKeys.get("revoked")!)), [401], `${route.name} revoked key with a live session`);
    }

    const sessions: [Label, number[] | "ok"][] = [
      ["anonymous", [401]],
      ["forgedCookie", [401]],
      ["ownerAExpired", [401]],
      ["ownerARevoked", [401]],
      ["seekerAExpired", [401]],
      ["seekerARevoked", [401]],
      ["unverifiedOrg", [403]],
      ["orglessOrg", [403]],
      ["ownerALocked", [403]],
      ["seekerALocked", [403]],
      ["seekerUnenrolled", [403]],
      ["reviewerA", [403]],
      ["ownerA", "ok"],
      ["seekerA", "ok"],
    ];
    for (const route of routes().filter((candidate) => !candidate.mutates)) {
      for (const [label, expected] of sessions) {
        const response = await route.call(who(label), {});
        const allowed =
          expected === "ok" && ((label === "ownerA" && route.kind === "org") || (label === "seekerA" && route.kind === "seeker"));
        if (allowed) {
          expect(response.status(), `${route.name} as ${label}`).toBeLessThan(300);
        } else {
          const statuses = expected === "ok" ? [403] : label === "reviewerA" && route.kind === "seeker" ? [403] : expected;
          await expectDeniedResponse(response, statuses, `${route.name} as ${label}`);
        }
      }
    }

    // Key self-description never echoes key material.
    for (const key of [w.orgKeys.get("all")!, w.seekerKeys.get("all")!]) {
      const described = await anon.get("/api/v1/me/key", { headers: bearer(key) });
      expect(described.ok()).toBe(true);
      expect(await described.text()).not.toContain(key.slice(11));
    }
    await expectDeniedResponse(await anon.get("/api/v1/me/key", { headers: bearer(w.orgKeys.get("revoked")!) }), [401], "describe revoked key");
  });

  test("REST v1: organisation B's key cannot read, upload to, or send from organisation A", async () => {
    const anon = who("anonymous");
    const b = bearer(w.orgBKey);
    const listed = await anon.get("/api/v1/requests", { headers: b });
    expect(listed.ok()).toBe(true);
    const ids = ((await listed.json()) as { requests: { id: string }[] }).requests.map((r) => r.id);
    expect(ids).toContain(w.reqB);
    expect(ids).not.toContain(w.reqA);
    const before = await rows.deliveryCount(w.reqA);
    const jdBefore = (await rows.requestRow(w.reqA)).jd_document_id;
    const attempts: [string, Promise<APIResponse>][] = [
      ["read role", anon.get(`/api/v1/requests/${w.reqA}`, { headers: b })],
      ["list submissions", anon.get(`/api/v1/requests/${w.reqA}/submissions`, { headers: b })],
      ["upload JD", anon.post(`/api/v1/requests/${w.reqA}/jd`, { headers: b, multipart: { jd: pdf("cross-tenant", "x.pdf") } })],
      ["send invitation", anon.post(`/api/v1/requests/${w.reqA}/send`, { headers: b, data: { email: email("cross-invite") } })],
    ];
    for (const [label, pending] of attempts) {
      await expectDeniedResponse(await pending, [404], `org B ${label}`);
    }
    expect(await rows.deliveryCount(w.reqA)).toBe(before);
    expect((await rows.requestRow(w.reqA)).jd_document_id).toBe(jdBefore);
    const report = await anon.get("/api/v1/reports/recruiter", { headers: b });
    expect(await report.text()).not.toContain(w.reqA);
    // Seeker keys are tenant-free but still owner-bound.
    const applications = await anon.get("/api/v1/me/applications", { headers: bearer(w.seekerKeys.get("all")!) });
    expect(((await applications.json()) as { applications: unknown[] }).applications).toHaveLength(1);
  });

  test("submission documents and exports follow tenant, role, share, and vault state", async () => {
    const view = (label: Label, id: string, download = false) =>
      who(label).get(`/api/documents/${id}/view${download ? "?download=1" : ""}`);

    // Allowed: the full bytes reach org roles with document rights, unlocked.
    for (const label of ["ownerA", "adminA", "complianceA"] as const) {
      const response = await view(label, w.docA, true);
      expect(response.status(), `${label} download`).toBe(200);
      expect((await response.body()).includes(Buffer.from(MARK.evidence)), `${label} receives the document`).toBe(true);
    }
    await expectDeniedResponse(await view("ownerALocked", w.docA), [409], "locked owner");
    for (const label of ["anonymous", "forgedCookie", "ownerAExpired", "ownerARevoked", "ownerB", "seekerB", "orglessOrg", "unverifiedOrg"] as const) {
      await expectDeniedResponse(await view(label, w.docA), [403], `document as ${label}`);
    }
    // Reviewers see a document only once its submission is shared with them, and never download it.
    await expectDeniedResponse(await view("reviewerA", w.docA), [403], "reviewer before share");
    await runOk("ownerA", "shareSubmission", { form: { submissionId: w.subA, userId: w.reviewerAId } });
    expect((await view("reviewerA", w.docA)).status()).toBe(200);
    await expectDeniedResponse(await view("reviewerA", w.docA, true), [403], "reviewer download");

    // Unknown and cross-tenant ids look the same as missing.
    await expectDeniedResponse(await view("ownerA", randomUUID()), [404], "unknown document");

    // Export: data-export roles of the owning tenant only.
    const exportA = (label: Label) => who(label).get(`/api/requests/${w.reqA}/export?format=json`);
    for (const label of ["ownerA", "adminA", "complianceA"] as const) {
      const response = await exportA(label);
      expect(response.status(), `${label} export`).toBe(200);
      expect(await response.text()).toContain(MARK.field);
    }
    for (const [label, statuses] of [
      ["anonymous", [403]],
      ["forgedCookie", [403]],
      ["ownerAExpired", [403]],
      ["reviewerA", [403]],
      ["recruiterA", [403]],
      ["seekerA", [403]],
      ["unverifiedOrg", [403]],
      ["ownerB", [404]],
    ] as const) {
      await expectDeniedResponse(await exportA(label), [...statuses], `export as ${label}`);
    }
    // A locked session must not decrypt: any refusal is acceptable, plaintext is not.
    const locked = await exportA("ownerALocked");
    expect(locked.status()).toBeGreaterThanOrEqual(400);
    expectNoLeak(await locked.text(), protectedValues(), "export while locked");
  });

  test("career documents stay with their owner and need the owner's key", async () => {
    const view = (label: Label, id: string) => who(label).get(`/api/wallet/documents/${id}/view`);
    const own = await view("seekerA", w.walletDocA);
    expect(own.status()).toBe(200);
    expect((await own.body()).includes(Buffer.from(MARK.walletA))).toBe(true);
    await expectDeniedResponse(await view("seekerALocked", w.walletDocA), [409], "locked seeker");
    for (const label of ["seekerB", "seekerUnenrolled"] as const) {
      await expectDeniedResponse(await view(label, w.walletDocA), [404], `wallet document as ${label}`);
    }
    for (const label of ["anonymous", "forgedCookie", "seekerAExpired", "seekerARevoked", "ownerA", "complianceA"] as const) {
      await expectDeniedResponse(await view(label, w.walletDocA), [403], `wallet document as ${label}`);
    }
    await expectDeniedResponse(await view("seekerA", w.walletDocB), [404], "seeker A reading seeker B");
    // Submission evidence is not reachable through the wallet route either.
    await expectDeniedResponse(await view("seekerA", w.docA), [404], "evidence via wallet route");
  });

  test("secure links: forwarded, replayed, wrong, exhausted, revoked, expired, consumed, and forged", async () => {
    const anon = who("anonymous");
    const otp = (client: APIRequestContext, token: string, code: string) =>
      callAction(client, act("verifyOtp"), { args: [token, code] }, { token });
    const expectRefused = (outcome: ActionOutcome, pattern: RegExp, context: string) => {
      expect(outcome.result?.ok, context).toBe(false);
      expect(outcome.result?.error ?? "", context).toMatch(pattern);
      expectNoLeak(outcome.body, protectedValues(), context);
    };

    // Forwarded: the code goes only to the invited address.
    const recipient = await newClient();
    const forwardCode = await otpFor(recipient, w.tokenForward, email("forward"));
    const stranger = who("seekerB");
    expectRefused(await otp(stranger, w.tokenForward, forwardCode === "000000" ? "111111" : "000000"), /not correct/, "forwarded guess");
    const respondAsStranger = await stranger.get(`/r/${w.tokenForward}/respond`, { maxRedirects: 0 });
    expect(respondAsStranger.status()).toBeGreaterThanOrEqual(300);
    expect(respondAsStranger.status()).toBeLessThan(400);
    expectRefused(
      await callAction(stranger, act("submitResponse"), { form: { consent: "on" } }, { token: w.tokenForward }),
      /session has expired/,
      "submit without a link session",
    );
    // The recipient verifies; replaying the same code from another browser fails.
    expect((await otp(recipient, w.tokenForward, forwardCode)).result?.ok).toBe(true);
    expectRefused(await otp(stranger, w.tokenForward, forwardCode), /expired|Request a new/, "replayed code");

    // A verified link session opens the role's JD, not another applicant's evidence.
    expect((await recipient.get(`/api/documents/${w.jdA}/view`)).status()).toBe(200);
    await expectDeniedResponse(await recipient.get(`/api/documents/${w.docA}/view`), [403], "link session reading evidence");
    await expectDeniedResponse(await anon.get(`/api/documents/${w.jdA}/view`), [403], "JD without a link session");
    const otherDraft = await callAction(recipient, act("loadDraftValues"), { args: [(await rows.accessToken(w.tokenLockout)).id] }, {
      token: w.tokenForward,
    });
    expect(otherDraft.result).toEqual({});

    // Exhausted attempts lock the code even when the right one arrives.
    const lockoutClient = await newClient();
    const lockoutCode = await otpFor(lockoutClient, w.tokenLockout, email("lockout"));
    const wrong = lockoutCode === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) await otp(lockoutClient, w.tokenLockout, wrong);
    expectRefused(await otp(lockoutClient, w.tokenLockout, lockoutCode), /Too many attempts/, "code after lockout");

    // Revoked through the recruiter's own action; expired by time.
    await runOk("ownerA", "revokeAccessToken", { form: { accessTokenId: (await rows.accessToken(w.tokenRevoked)).id } });
    expectRefused(await callAction(anon, act("requestOtp"), { args: [w.tokenRevoked] }, { token: w.tokenRevoked }), /revoked/, "revoked link");
    await expect(async () => {
      const page = await anon.get(`/r/${w.tokenRevoked}`);
      expect(await page.text()).toMatch(/revoked/i);
    }).toPass();
    await rows.expireAccessToken(w.tokenExpired);
    expectRefused(await callAction(anon, act("requestOtp"), { args: [w.tokenExpired] }, { token: w.tokenExpired }), /expired/, "expired link");
    expectRefused(await callAction(anon, act("requestOtp"), { args: [randomBytes(32).toString("base64url")] }, { token: "unknown" }), /not valid/, "unknown link");

    // Consumed: the applicant's own link cannot be reopened or resubmitted.
    expectRefused(await callAction(anon, act("requestOtp"), { args: [w.tokenA] }, { token: w.tokenA }), /already been completed/, "consumed link");
    expectRefused(
      await callAction(who("seekerA"), act("submitResponse"), { form: { consent: "on" } }, { token: w.tokenA }),
      // Submitting clears the link session, so the refusal comes first from that.
      /already been completed|session has expired/,
      "resubmit a consumed link",
    );

    // A link-session cookie with a forged signature is ignored.
    const forged = await clientWithCookie(`rv_link_session=${w.atForwardId}.${Date.now() + 3_600_000}.${randomBytes(32).toString("base64url")}`);
    await expectDeniedResponse(await forged.get(`/api/documents/${w.jdA}/view`), [403], "forged link session");
    expectRefused(
      await callAction(forged, act("saveDraft"), { form: {} }, { token: w.tokenForward }),
      /session has expired/,
      "draft with a forged link session",
    );
    for (const client of [recipient, lockoutClient, forged]) await client.dispose();
  });

  test("onboarding cannot create a workspace or vault data without a customer key", async () => {
    const orgsBefore = await rows.organisationCount();
    for (const [label, form] of [
      ["no key", { name: `Matrix keyless ${RUN}` }],
      ["unacknowledged key", { name: `Matrix keyless ${RUN}`, ...keyForm(newCustomerKey()), keyBackupAck: "" }],
      ["mismatched key", { name: `Matrix keyless ${RUN}`, ...keyForm(newCustomerKey()), encryptionKeyConfirm: newCustomerKey() }],
      ["weak key", { name: `Matrix keyless ${RUN}`, ...keyForm("A".repeat(43)) }],
    ] as const) {
      const outcome = await run("orglessOrg", "createOrganisation", { form });
      expect(outcome.result?.ok, label).toBe(false);
    }
    expect(await rows.organisationCount()).toBe(orgsBefore);
    expect(await rows.orgIdForEmail(email("orgless"))).toBeNull();

    // A job seeker without a key can sign in but cannot store anything.
    const before = await rows.candidateRowCounts(email("seekerUnenrolled"));
    expect(before).toEqual({ items: 0, documents: 0, vaults: 0 });
    for (const [name, form] of [
      ["upsertWalletItem", { type: "clearance_id", value: "x" }],
      ["uploadWalletDocument", { kind: "resume", file: pdf("unenrolled") }],
      ["createCandidateApiKey", { name: "unenrolled", scopes: ["profile:read"], ttlDays: "30" }],
    ] as const) {
      expect(denied(await run("seekerUnenrolled", name, { form })), name).toBe(true);
    }
    expect(await rows.candidateRowCounts(email("seekerUnenrolled"))).toEqual(before);
    // Completed setup stays closed, even with the real bootstrap token.
    const setup = await run("orglessOrg", "completePlatformSetup", {
      form: { organisationName: "Matrix takeover", bootstrapToken: BOOTSTRAP_TOKEN, ...keyForm(newCustomerKey()) },
    });
    expect(denied(setup) || isProxyRedirect(setup)).toBe(true);
    expect(await rows.organisationCount()).toBe(orgsBefore);
  });

  test("Resend webhook: only fresh svix signatures change suppressions", async () => {
    const anon = who("anonymous");
    const target = email("bounce");
    const payload = JSON.stringify({ type: "email.bounced", data: { to: [target] } });
    const signed = (id: string, ts: number, secret = WEBHOOK_SECRET) => {
      const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      const signature = createHmac("sha256", key).update(`${id}.${ts}.${payload}`).digest("base64");
      return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${signature}`, "content-type": "application/json" };
    };
    const now = Math.floor(Date.now() / 1000);
    const post = (headers: Record<string, string>) => anon.post("/api/webhooks/resend", { headers, data: payload });
    for (const [label, headers] of [
      ["unsigned", { "content-type": "application/json" }],
      ["wrong secret", signed("msg_1", now, "whsec_" + randomBytes(24).toString("base64"))],
      ["stale timestamp", signed("msg_2", now - 600)],
      ["future timestamp", signed("msg_3", now + 600)],
      ["malformed signature", { ...signed("msg_4", now), "svix-signature": "v1,AAAA" }],
    ] as const) {
      expect((await post(headers)).status(), label).toBe(401);
    }
    expect(await rows.suppressed(target)).toBe(false);
    expect((await post(signed("msg_ok", now))).status()).toBe(200);
    expect(await rows.suppressed(target)).toBe(true);
    // Replaying a captured delivery inside the window is accepted and idempotent.
    expect((await post(signed("msg_ok", now))).status()).toBe(200);
  });

  test("no plaintext, customer key, API key, or link token reaches object storage or the database", async () => {
    const secrets = [...Object.values(MARK), ...Object.values(KEYS), ...w.orgKeys.values(), ...w.seekerKeys.values(), w.orgBKey, ...w.linkTokens];
    const s3 = new S3Client({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
    let objects = 0;
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        const got = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: object.Key }));
        const bytes = Buffer.from(await got.Body!.transformToByteArray());
        objects += 1;
        for (const secret of secrets) {
          expect(bytes.includes(Buffer.from(secret)), `object ${objects} contains protected data`).toBe(false);
        }
      }
      token = page.NextContinuationToken;
    } while (token);
    // Evidence, JD, and two career documents at least.
    expect(objects).toBeGreaterThanOrEqual(4);

    const text = await rows.allRowText();
    for (const secret of secrets) {
      expect(text.includes(secret), "a database row contains protected data").toBe(false);
    }
  });

  // reqA belongs to ownerA. The Server Action matrix also denies recruiterA
  // the role-management actions on it.
  test("recruiters cannot reach submissions on roles they do not own", async () => {
    const document = await who("recruiterA").get(`/api/documents/${w.docA}/view`);
    // Soft, so both cells run and are reported.
    expect.soft(document.status(), "recruiter reading another recruiter's evidence").toBe(403);
    const selfShare = await run("recruiterA", "shareSubmission", { form: { submissionId: w.subA, userId: w.recruiterAId } });
    expect.soft(denied(selfShare), "recruiter self-share").toBe(true);
  });
});

function isProxyRedirect(outcome: ActionOutcome) {
  // The proxy answers a cookie-less request to a protected page with a
  // redirect to sign-in before the action runs.
  return outcome.status >= 300 && outcome.status < 400 && outcome.result === undefined;
}

// ---------------------------------------------------------------------------
// Server Action matrix
// ---------------------------------------------------------------------------

interface ActionCell {
  action: string;
  deny: Label[];
  input: (label: Label) => ActionArgs;
  params?: () => Record<string, string>;
  /** Snapshot that must not change across the denied calls. */
  state?: () => Promise<unknown>;
  /** When an ok:false could also be input validation, the reason must match. */
  reason?: RegExp;
  /** Custom refusal check (actions that return data rather than ok). */
  refused?: (outcome: ActionOutcome) => boolean;
}

const ORG_OUTSIDERS: Label[] = ["anonymous", "forgedCookie", "ownerAExpired", "ownerARevoked", "unverifiedOrg", "orglessOrg", "seekerA"];
const SEEKER_OUTSIDERS: Label[] = ["anonymous", "forgedCookie", "seekerAExpired", "seekerARevoked", "ownerA", "unverifiedOrg"];
const form = (values: Record<string, string | string[] | ReturnType<typeof pdf>>) => () => ({ form: values }) as ActionArgs;
const none = () => ({ args: [] }) as ActionArgs;

function backupForm() {
  return {
    enabled: "on",
    hourUtc: "3",
    retainCount: "7",
    r2AccountId: "0123456789abcdef0123456789abcdef",
    r2Bucket: "matrix-bucket",
    r2AccessKeyId: "matrix-access-key-id",
    r2SecretAccessKey: "matrix-secret-value",
  };
}

function actionCells(): ActionCell[] {
  const orgKeyStillWorks = async () => {
    const client = await newClient();
    const status = (await client.get("/api/v1/requests", { headers: bearer(w.orgKeys.get("all")!) })).status();
    await client.dispose();
    return status;
  };
  return [
    // --- organisation and membership ---
    {
      action: "createOrganisation",
      deny: ["anonymous", "forgedCookie", "seekerA", "unverifiedOrg", "ownerA", "ownerAExpired"],
      input: form({ name: `Matrix intruder ${RUN}`, ...keyForm(newCustomerKey()) }),
      state: () => rows.organisationCount(),
    },
    {
      action: "addMember",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: (label) => ({ form: { email: label === "ownerB" ? email("reviewera") : email("orgless"), role: "admin" } }),
      state: async () => [await rows.orgIdForEmail(email("orgless")), await rows.orgIdForEmail(email("reviewera"))],
    },
    {
      action: "updateMemberRole",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { membershipId: w.memReviewerA, role: "admin" } }),
      state: () => rows.membershipRole(w.memReviewerA),
    },
    {
      action: "removeMember",
      deny: [...ORG_OUTSIDERS, "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { membershipId: w.memReviewerA } }),
      state: () => rows.membershipRole(w.memReviewerA),
    },
    {
      action: "updateOrgSettings",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA"],
      input: form({ retentionDays: "7", senderName: "Matrix intruder" }),
      state: () => rows.orgSettings(w.orgA),
    },
    {
      action: "verifyDomain",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA"],
      input: none,
      reason: /Unlock|role does not allow|Sign in|Organisation account|Verify your email|membership/,
    },
    // --- roles and links ---
    {
      action: "createRequest",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "reviewerA", "complianceA"],
      input: form({ title: `Matrix intruder role ${RUN}`, fields: ["resume"] }),
      state: () => rows.requestCountForOrg(w.orgA),
    },
    {
      action: "deleteTemplate",
      deny: [...ORG_OUTSIDERS, "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { templateId: w.templateA } }),
      state: () => rows.templateId(w.orgA),
    },
    {
      action: "sendRequest",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { requestId: w.reqA, recipientEmail: email("intruder-invite") } }),
      state: () => rows.deliveryCount(w.reqA),
    },
    {
      action: "revokeAccessToken",
      deny: [...ORG_OUTSIDERS, "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { accessTokenId: w.atForwardId } }),
      state: async () => (await rows.accessToken(w.tokenForward)).revoked_at,
    },
    {
      action: "setRequestStatus",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { requestId: w.reqA, status: "archived" } }),
      state: async () => (await rows.requestRow(w.reqA)).status,
    },
    {
      action: "shareSubmission",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: (label) => ({ form: { submissionId: w.subA, userId: label === "ownerB" ? w.ownerBId : w.reviewerAId } }),
      state: () => rows.shareCount(w.subA),
    },
    {
      action: "setSubmissionStatus",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "reviewerA", "recruiterA", "ownerB"],
      input: () => ({ form: { submissionId: w.subA, status: "shortlisted" } }),
      state: async () => (await rows.submissionRow(w.subA)).status,
    },
    {
      action: "deleteSubmission",
      deny: [...ORG_OUTSIDERS, "recruiterA", "reviewerA", "ownerB"],
      input: () => ({ form: { submissionId: w.subA } }),
      state: async () => (await rows.submissionRow(w.subA)).purged_at,
    },
    {
      action: "updateRecruiterMatchSettings",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "reviewerA", "complianceA"],
      input: form({ enabled: "on", minimumMatchScore: "60" }),
      state: () => rows.query(`select enabled, minimum_match_score from recruiter_match_settings where org_id = $1`, [w.orgA]),
    },
    // --- platform backups: only the platform organisation's owner ---
    {
      action: "updateBackupSettings",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "adminA", "recruiterA", "reviewerA", "complianceA", "ownerA", "ownerB"],
      input: form(backupForm()),
      state: () => rows.query(`select id from backup_config`),
      reason: /owner|platform organisation|Unlock|role does not allow|Sign in|Organisation account|Verify your email|membership/,
    },
    {
      action: "runBackupNow",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "adminA", "recruiterA", "reviewerA", "complianceA", "ownerA", "ownerB"],
      input: none,
      state: () => rows.query(`select id from backup_runs`),
      reason: /owner|platform organisation|Unlock|role does not allow|Sign in|Organisation account|Verify your email|membership/,
    },
    // --- API keys ---
    {
      action: "createApiKey",
      deny: [...ORG_OUTSIDERS, "ownerALocked", "reviewerA", "complianceA"],
      input: form({ name: `matrix-intruder-${RUN}`, scopes: ["roles:read"], ttlDays: "30" }),
      state: () => rows.query(`select id from api_keys where name = $1`, [`matrix-intruder-${RUN}`]),
    },
    {
      action: "rotateApiKey",
      deny: [...ORG_OUTSIDERS, "adminA", "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { keyId: w.orgKeyIds.get("all")!, ttlDays: "30" } }),
      state: async () => [await rows.apiKeyRevoked(w.orgKeyIds.get("all")!), await orgKeyStillWorks()],
    },
    {
      action: "revokeApiKey",
      deny: [...ORG_OUTSIDERS, "recruiterA", "reviewerA", "complianceA", "ownerB"],
      input: () => ({ form: { keyId: w.orgKeyIds.get("all")! } }),
      state: async () => [await rows.apiKeyRevoked(w.orgKeyIds.get("all")!), await orgKeyStillWorks()],
    },
    {
      action: "createCandidateApiKey",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: form({ name: `matrix-seeker-intruder-${RUN}`, scopes: ["profile:read"], ttlDays: "30" }),
      state: () => rows.query(`select id from candidate_api_keys where name = $1`, [`matrix-seeker-intruder-${RUN}`]),
    },
    {
      action: "rotateCandidateApiKey",
      deny: [...SEEKER_OUTSIDERS, "seekerB"],
      input: () => ({ form: { keyId: w.seekerKeyIds.get("all")!, ttlDays: "30" } }),
      state: () => rows.apiKeyRevoked(w.seekerKeyIds.get("all")!, "candidate_api_keys"),
    },
    {
      action: "revokeCandidateApiKey",
      deny: [...SEEKER_OUTSIDERS, "seekerB"],
      input: () => ({ form: { keyId: w.seekerKeyIds.get("all")! } }),
      state: () => rows.apiKeyRevoked(w.seekerKeyIds.get("all")!, "candidate_api_keys"),
    },
    // --- job seeker wallet and profile ---
    {
      action: "upsertWalletItem",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: form({ type: "clearance_id", value: "matrix-intruder" }),
      state: async () => [await rows.candidateRowCounts(email("seekerA")), await rows.candidateRowCounts(email("seekerUnenrolled"))],
    },
    {
      action: "deleteWalletItem",
      deny: [...SEEKER_OUTSIDERS, "seekerB", "seekerUnenrolled"],
      input: () => ({ form: { id: w.walletItemA } }),
      state: () => rows.walletItemIds(email("seekerA")),
    },
    {
      action: "uploadWalletDocument",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: form({ kind: "resume", file: pdf("matrix-intruder") }),
      state: async () => [await rows.candidateRowCounts(email("seekerA")), await rows.candidateRowCounts(email("seekerUnenrolled"))],
    },
    {
      action: "deleteWalletDocument",
      deny: [...SEEKER_OUTSIDERS, "seekerB", "seekerUnenrolled"],
      input: () => ({ form: { id: w.walletDocA } }),
      state: () => rows.walletDocumentIds(email("seekerA")),
    },
    {
      action: "revokeWalletShare",
      deny: [...SEEKER_OUTSIDERS, "seekerB", "seekerUnenrolled"],
      input: form({ id: randomUUID() }),
    },
    {
      action: "toggleSavedRole",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: () => ({ form: { requestId: w.reqA } }),
      state: () => rows.query(`select count(*)::int as n from saved_roles`),
    },
    {
      action: "requestErasure",
      deny: SEEKER_OUTSIDERS,
      input: form({ confirm: "DELETE" }),
      state: () => rows.query(`select erased_at from "user" where email = $1`, [email("seekerA")]),
    },
    {
      action: "upsertDiscoveryProfile",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: form({ discoverable: "on", clearanceLevel: "nv1", skills: "intruder" }),
      state: () => rows.query(`select count(*)::int as n from discovery_profiles`),
    },
    {
      action: "updateJobAlertSubscription",
      deny: [...SEEKER_OUTSIDERS, "seekerALocked", "seekerUnenrolled"],
      input: form({ enabled: "on", skills: "intruder" }),
      state: () => rows.query(`select count(*)::int as n from job_alert_subscriptions`),
    },
    // --- customer key lifecycle ---
    {
      action: "enrollVault",
      deny: ["anonymous", "forgedCookie", "seekerA", "ownerA", "adminA", "ownerAExpired"],
      input: form(keyForm(newCustomerKey())),
      state: () => rows.query(`select count(*)::int as n from vault_keys`),
    },
    {
      action: "unlockVault",
      deny: ["anonymous", "forgedCookie", "ownerALocked", "seekerALocked", "seekerUnenrolled", "orglessOrg"],
      // Each locked principal presents a real key belonging to someone else.
      input: (label) => ({ form: { encryptionKey: label === "ownerALocked" ? KEYS.orgB : KEYS.seekerB } }),
    },
    {
      action: "rotateVault",
      deny: ["anonymous", "forgedCookie", "adminA", "reviewerA", "ownerAExpired", "orglessOrg"],
      input: form({ currentEncryptionKey: KEYS.orgA, ...keyForm(newCustomerKey()) }),
      state: () => rows.query(`select count(*)::int as n from vault_rotations`),
      reason: /owner|Sign in|organisation before/,
    },
    {
      action: "cancelVaultRotationAction",
      deny: ["anonymous", "forgedCookie", "adminA", "reviewerA", "ownerAExpired", "orglessOrg"],
      input: form({ currentEncryptionKey: KEYS.orgA }),
      reason: /owner|Sign in|organisation before/,
    },
    {
      action: "migrateLegacyRecords",
      deny: ["anonymous", "forgedCookie", "adminA", "ownerALocked", "orglessOrg", "seekerUnenrolled"],
      input: none,
      reason: /owner|Sign in|Unlock|organisation before|Finish account setup/,
    },
    {
      action: "completePlatformSetup",
      deny: ["anonymous", "ownerA", "orglessOrg", "seekerA"],
      input: form({ organisationName: "Matrix takeover", bootstrapToken: BOOTSTRAP_TOKEN, ...keyForm(newCustomerKey()) }),
      state: () => rows.organisationCount(),
    },
    // --- secure links (state checks in the secure-link test) ---
    {
      action: "requestOtp",
      deny: ["anonymous", "ownerA", "seekerB"],
      // Links are capabilities, not principals: without a valid token nobody gets a code.
      input: () => ({ args: [randomBytes(32).toString("base64url")] }),
      params: () => ({ token: "x" }),
      reason: /not valid|revoked|expired|completed/,
    },
    {
      action: "verifyOtp",
      deny: ["anonymous", "ownerA", "seekerB"],
      input: () => ({ args: [randomBytes(32).toString("base64url"), "000000"] }),
      params: () => ({ token: "x" }),
      reason: /not valid|revoked|expired|completed|not correct|Too many/,
    },
    {
      action: "submitResponse",
      deny: ["anonymous", "forgedCookie", "ownerA", "seekerB"],
      input: form({ consent: "on" }),
      params: () => ({ token: "x" }),
      state: () => rows.query(`select count(*)::int as n from submissions`),
    },
    {
      action: "saveDraft",
      deny: ["anonymous", "forgedCookie", "ownerA", "seekerB"],
      input: form({ consent: "on" }),
      params: () => ({ token: "x" }),
      state: () => rows.query(`select count(*)::int as n from submissions`),
    },
    {
      action: "loadDraftValues",
      deny: ["anonymous", "forgedCookie", "ownerA", "seekerB"],
      input: () => ({ args: [w.atForwardId] }),
      params: () => ({ token: "x" }),
      refused: (outcome) => JSON.stringify(outcome.result ?? {}) === "{}",
    },
  ];
}
