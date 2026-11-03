import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, request, type APIRequestContext, type APIResponse } from "@playwright/test";
import { waitForEmail } from "./email-helpers";

/**
 * Direct-request helpers for the security matrix. Every call here goes over
 * HTTP to the running app with a real session cookie, API key, or link
 * session, never through the UI. Values are synthetic and never logged.
 */

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
export const PASSWORD = "E2eMatrix!" + "Secure-123";
export const SESSION_COOKIE = "better-auth.session_token";

/** A fresh, random 256-bit customer key in the accepted base64url form. */
export function newCustomerKey() {
  return randomBytes(32).toString("base64url");
}

export async function newClient(extraHTTPHeaders: Record<string, string> = {}) {
  // Same-origin, like the browser: BetterAuth and Server Actions both check Origin.
  // Development servers compile a route on first request; allow for that.
  return request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL, ...extraHTTPHeaders },
    timeout: 120_000,
  });
}

// ---------------------------------------------------------------------------
// Server Action discovery
// ---------------------------------------------------------------------------

export interface ActionRef {
  id: string;
  exportedName: string;
  filename: string;
  /** Page path that loads the action's module, with dynamic segments still bracketed. */
  route: string;
}

function manifestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "cache" || entry === "static") continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry === "server-reference-manifest.json") out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function workerRoute(worker: string) {
  // "app/(seeker)/documents/page" -> "/documents"
  const parts = worker.replace(/^app\//, "").replace(/\/page$/, "").split("/");
  const route = parts.filter((part) => !/^\(.*\)$/.test(part) && part !== "page").join("/");
  return `/${route}`.replace(/\/$/, "") || "/";
}

/**
 * Action IDs come from the build's server reference manifests, which list
 * every export of each "use server" module a page loads, whether or not the
 * page's UI calls it. That is exactly the set an attacker can reach.
 */
export function loadActionRefs(distDir = process.env.NEXT_DIST_DIR ?? ".next-e2e"): Map<string, ActionRef> {
  const refs = new Map<string, ActionRef>();
  for (const file of manifestFiles(distDir)) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      node?: Record<string, { workers: Record<string, unknown>; exportedName?: string; filename?: string }>;
    };
    for (const [id, entry] of Object.entries(manifest.node ?? {})) {
      if (!entry.exportedName || !entry.filename?.startsWith("src/actions/")) continue;
      const routes = Object.keys(entry.workers).filter((worker) => worker.endsWith("/page")).map(workerRoute);
      // Prefer a static page so the post-action render needs no dynamic params.
      const route = routes.find((candidate) => !candidate.includes("[")) ?? routes[0];
      const existing = refs.get(entry.exportedName);
      if (!route || (existing && !existing.route.includes("["))) continue;
      refs.set(entry.exportedName, { id, exportedName: entry.exportedName, filename: entry.filename, route });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Server Action invocation
// ---------------------------------------------------------------------------

export type FieldValue = string | { name: string; mimeType: string; buffer: Buffer };
export type ActionArgs = { form: Record<string, FieldValue | readonly FieldValue[]> } | { args: unknown[] };

export interface ActionOutcome {
  status: number;
  /** The action's return value, when it returned normally. */
  result?: { ok?: boolean; error?: string; id?: string; key?: string; [key: string]: unknown };
  /** The thrown error message (development builds include it). */
  thrown?: string;
  body: string;
}

/** A denial: the action threw, returned ok:false, or the request was refused. */
export function denied(outcome: ActionOutcome) {
  return outcome.status >= 400 || outcome.thrown !== undefined || outcome.result?.ok === false;
}

function parseFlight(body: string): Pick<ActionOutcome, "result" | "thrown"> {
  const rows = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^([0-9a-f]+):(.*)$/.exec(line);
    if (match) rows.set(match[1], match[2]);
  }
  const root = rows.get("0");
  if (!root) return {};
  let ref: string | undefined;
  try {
    ref = (JSON.parse(root) as { a?: string }).a;
  } catch {
    return {};
  }
  const target = ref?.startsWith("$@") ? rows.get(ref.slice(2)) : undefined;
  if (target === undefined) return {};
  if (target.startsWith("E")) {
    const error = JSON.parse(target.slice(1)) as { message?: string; digest?: string };
    return { thrown: error.message ?? error.digest ?? "error" };
  }
  try {
    return { result: JSON.parse(target) };
  } catch {
    return {};
  }
}

/**
 * POST a Server Action exactly as the React client does: `Next-Action` names
 * the action, and the body is React's reply encoding (a FormData argument
 * becomes part `0 = ["$K1"]` plus `_1_<field>` parts).
 */
export async function callAction(
  client: APIRequestContext,
  ref: ActionRef,
  input: ActionArgs,
  routeParams: Record<string, string> = {},
): Promise<ActionOutcome> {
  const route = ref.route.replace(/\[([^\]]+)\]/g, (_, name: string) => routeParams[name] ?? "x");
  const headers = { "next-action": ref.id, accept: "text/x-component" };
  let response: APIResponse;
  if ("form" in input) {
    // The server reads the referenced parts in order and stops at the first
    // foreign name, so the fields precede the root part, as React sends them.
    const form = new FormData();
    for (const [name, value] of Object.entries(input.form)) {
      for (const item of Array.isArray(value) ? value : [value]) appendField(form, `_1_${name}`, item);
    }
    form.append("0", '["$K1"]');
    response = await client.post(route, { headers, multipart: form, maxRedirects: 0 });
  } else {
    response = await client.post(route, {
      headers: { ...headers, "content-type": "text/plain;charset=UTF-8" },
      data: JSON.stringify(input.args),
      maxRedirects: 0,
    });
  }
  const body = await response.text();
  return { status: response.status(), body, ...parseFlight(body) };
}

function appendField(form: FormData, name: string, value: FieldValue) {
  if (typeof value === "string") form.append(name, value);
  else form.append(name, new Blob([new Uint8Array(value.buffer)], { type: value.mimeType }), value.name);
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

export interface Principal {
  label: string;
  email: string;
  client: APIRequestContext;
}

async function expectOk(response: APIResponse, what: string) {
  expect(response.status(), `${what} (HTTP ${response.status()})`).toBeLessThan(400);
}

/** Sign up through the real auth API. BetterAuth signs the new account in. */
export async function signUp(label: string, email: string, accountType: "org" | "seeker") {
  const client = await newClient();
  const response = await client.post("/api/auth/sign-up/email", {
    data: { name: `Matrix ${label}`, email, password: PASSWORD, ...(accountType === "org" ? { accountType } : {}) },
  });
  await expectOk(response, `sign up ${label}`);
  return { label, email, client } satisfies Principal;
}

/** Follow the emailed verification link, which also signs the account in. */
export async function verifyByEmail(principal: Principal, after: number) {
  const mail = await waitForEmail({ to: principal.email, subject: "Verify your email: Recruvault", after });
  expect(mail.ctaUrl).toBeTruthy();
  const response = await principal.client.get(mail.ctaUrl!, { maxRedirects: 0 });
  expect(response.status(), "verification link").toBeLessThan(400);
}

/** A separate browser session for an existing account (no vault unlock yet). */
export async function signIn(label: string, email: string, password = PASSWORD) {
  const client = await newClient();
  const response = await client.post("/api/auth/sign-in/email", { data: { email, password } });
  await expectOk(response, `sign in ${label}`);
  return { label, email, client } satisfies Principal;
}

export async function sessionCookie(client: APIRequestContext) {
  const state = await client.storageState();
  const cookie = state.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error("No session cookie.");
  return cookie.value;
}

/** A client that presents exactly this Cookie header and nothing else. */
export async function clientWithCookie(cookieHeader: string) {
  return newClient({ cookie: cookieHeader });
}

export async function cookieHeaderOf(client: APIRequestContext) {
  const state = await client.storageState();
  return state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Keys and markers must never appear in a denial body. */
export function expectNoLeak(body: string, secrets: string[], context: string) {
  for (const secret of secrets) {
    if (secret && body.includes(secret)) {
      throw new Error(`${context}: response body contains protected data.`);
    }
  }
}
