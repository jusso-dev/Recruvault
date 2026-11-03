// Production-mode smoke test against the standalone build.
//
//   npm run build && node scripts/smoke-production.mjs
//
// Expects a production-shaped environment (https APP_URL, real-looking
// secrets, a migrated DATABASE_URL). Checks response headers (CSP nonces,
// caching, framing, CORS), session cookie flags, and that test-only switches
// stop the server from starting. Prints check names and pass/fail only, never
// header or cookie values.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const server = `${process.env.NEXT_DIST_DIR ?? ".next"}/standalone/server.js`;
if (!existsSync(server)) {
  console.error(`Missing ${server}. Run npm run build first.`);
  process.exit(1);
}

const PORT = Number(process.env.SMOKE_PORT ?? 3200);
const base = `http://127.0.0.1:${PORT}`;
const origin = process.env.APP_URL;
// The only browser origin allowed to call /api/v1 during the smoke run.
const apiOrigin = "https://api-client.example.org";
const foreignOrigin = "https://attacker.example";
const failures = [];

function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
}

function start(extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOSTNAME: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Kept in memory for matching only, never printed: it can hold env values.
  let output = "";
  const keep = (chunk) => (output = (output + chunk).slice(-65_536));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = false;
  const exit = new Promise((r) => child.once("exit", () => r((exited = true))));
  return { child, exited: () => exited, exit, output: () => output };
}

async function live(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/live`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function stop(proc) {
  if (!proc.exited()) proc.child.kill("SIGTERM");
  await proc.exit;
}

/** Exits on its own within the timeout, without ever serving. */
async function refusesToStart(proc, timeoutMs) {
  const timer = new Promise((r) => setTimeout(r, timeoutMs, false));
  const exited = await Promise.race([proc.exit, timer]);
  return exited && !(await live(1_000));
}

const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1] ?? "";

function baselineHeaders(name, res, frame) {
  check(`${name}: HSTS is set`, /max-age=\d+/.test(res.headers.get("strict-transport-security") ?? ""));
  check(`${name}: nosniff is set`, res.headers.get("x-content-type-options") === "nosniff");
  check(`${name}: Referrer-Policy is set`, res.headers.get("referrer-policy") === "strict-origin-when-cross-origin");
  check(`${name}: Permissions-Policy is set`, /camera=\(\)/.test(res.headers.get("permissions-policy") ?? ""));
  check(`${name}: X-Frame-Options is ${frame}`, res.headers.get("x-frame-options") === frame);
  check(`${name}: x-powered-by is absent`, !res.headers.has("x-powered-by"));
}

/** No CORS grant at all, for preflight and actual requests, from any origin. */
async function noCors(name, path, method) {
  for (const from of [apiOrigin, foreignOrigin]) {
    const label = from === apiOrigin ? "API origin" : "foreign origin";
    const preflight = await fetch(`${base}${path}`, {
      method: "OPTIONS",
      headers: { origin: from, "access-control-request-method": method, "access-control-request-headers": "content-type, authorization" },
    });
    const actual = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: { origin: from, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    for (const [kind, res] of [["preflight", preflight], [method, actual]]) {
      check(
        `${name}: ${kind} from ${label} gets no Access-Control-Allow-Origin`,
        !res.headers.has("access-control-allow-origin") && !res.headers.has("access-control-allow-credentials"),
      );
    }
  }
}

const main = start({ API_CORS_ORIGINS: apiOrigin });
try {
  check("server becomes live", await live(60_000));

  const page = await fetch(`${base}/setup`, { redirect: "manual" });
  const csp = page.headers.get("content-security-policy") ?? "";
  const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
  check("page has a Content-Security-Policy", csp.length > 0);
  check("script-src uses a nonce", /'nonce-[^']+'/.test(scriptSrc));
  check("script-src has no unsafe-inline or unsafe-eval", !/unsafe-inline|unsafe-eval/.test(scriptSrc));
  check("style-src has no unsafe-inline", !/unsafe-inline/.test(csp.split(";").find((d) => d.trim().startsWith("style-src")) ?? ""));
  check("object-src is none", /object-src 'none'/.test(csp));
  check("frame-ancestors is none", /frame-ancestors 'none'/.test(csp));
  baselineHeaders("page", page, "DENY");

  const html = await page.text();
  const nonce = nonceOf(csp);
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  check("page renders scripts", scripts.length > 0);
  check("every script tag carries this response's nonce", scripts.every((tag) => tag.includes(`nonce="${nonce}"`)));
  const cacheControl = page.headers.get("cache-control") ?? "";
  check("page is private and no-store", /private/.test(cacheControl) && /no-store/.test(cacheControl));
  check("page is not served from the Next.js cache", !page.headers.has("x-nextjs-cache"));
  const again = await fetch(`${base}/setup`, { redirect: "manual" });
  const againNonce = nonceOf(again.headers.get("content-security-policy"));
  check("each response gets a distinct nonce", againNonce.length > 0 && againNonce !== nonce);
  check("a later response does not contain an earlier nonce", !(await again.text()).includes(nonce));

  const missing = await fetch(`${base}/no-such-page`, { redirect: "manual" });
  check("unknown paths also get a nonce policy", /'nonce-[^']+'/.test(missing.headers.get("content-security-policy") ?? ""));

  const docs = await fetch(`${base}/api/v1/docs`);
  const docsCsp = docs.headers.get("content-security-policy") ?? "";
  check("API docs: served", docs.ok && /text\/html/.test(docs.headers.get("content-type") ?? ""));
  check("API docs: frame-ancestors is none", /frame-ancestors 'none'/.test(docsCsp));
  check("API docs: no script can run", /script-src 'none'/.test(docsCsp) && /default-src 'none'/.test(docsCsp));
  check("API docs: no scripts and no external origins", !/https?:\/\//.test(docsCsp) && !/<script/i.test(await docs.text()));
  check("API docs: no-store", /no-store/.test(docs.headers.get("cache-control") ?? ""));
  baselineHeaders("API docs", docs, "DENY");

  // Only the organisation document view is embedded (by the secure-link page).
  const documentView = await fetch(`${base}/api/documents/00000000-0000-4000-8000-000000000000/view`);
  baselineHeaders("document view route", documentView, "SAMEORIGIN");
  const walletView = await fetch(`${base}/api/wallet/documents/00000000-0000-4000-8000-000000000000/view`);
  baselineHeaders("wallet view route", walletView, "DENY");

  // CORS: only /api/v1, only for API_CORS_ORIGINS.
  const allowedPreflight = await fetch(`${base}/api/v1/me/profile`, {
    method: "OPTIONS",
    headers: { origin: apiOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  check("API preflight from an allowed origin succeeds", allowedPreflight.status === 204);
  check("API preflight echoes only the allowed origin", allowedPreflight.headers.get("access-control-allow-origin") === apiOrigin);
  check("API preflight allows the Authorization header", /authorization/i.test(allowedPreflight.headers.get("access-control-allow-headers") ?? ""));
  check("API preflight varies on Origin", /origin/i.test(allowedPreflight.headers.get("vary") ?? ""));
  check("API grants no credentialed CORS", !allowedPreflight.headers.has("access-control-allow-credentials"));
  const allowedGet = await fetch(`${base}/api/v1/openapi.json`, { headers: { origin: apiOrigin } });
  check("API request from an allowed origin gets its origin back", allowedGet.headers.get("access-control-allow-origin") === apiOrigin);
  const foreignPreflight = await fetch(`${base}/api/v1/me/profile`, {
    method: "OPTIONS",
    headers: { origin: foreignOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  const foreignGet = await fetch(`${base}/api/v1/openapi.json`, { headers: { origin: foreignOrigin } });
  check("API preflight from another origin gets no CORS grant", !foreignPreflight.headers.has("access-control-allow-origin"));
  check("API request from another origin gets no CORS grant", !foreignGet.headers.has("access-control-allow-origin"));
  await noCors("auth session", "/api/auth/get-session", "GET");
  await noCors("auth sign-in", "/api/auth/sign-in/email", "POST");
  await noCors("webhooks", "/api/webhooks/resend", "POST");
  await noCors("document view", "/api/documents/00000000-0000-4000-8000-000000000000/view", "GET");
  await noCors("wallet document view", "/api/wallet/documents/00000000-0000-4000-8000-000000000000/view", "GET");
  await noCors("request export", "/api/requests/00000000-0000-4000-8000-000000000000/export", "GET");

  const email = `smoke-${randomBytes(6).toString("hex")}@example.org`;
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: randomBytes(18).toString("base64url"), name: "Smoke Test" }),
  });
  const cookies = signup.headers.getSetCookie().filter((c) => /session_token/i.test(c));
  check("sign-up sets a session cookie", cookies.length > 0);
  check(
    "session cookie is Secure, HttpOnly, and SameSite",
    cookies.length > 0 && cookies.every((c) => /;\s*Secure/i.test(c) && /;\s*HttpOnly/i.test(c) && /;\s*SameSite=(Lax|Strict)/i.test(c)),
  );
} finally {
  await stop(main);
}

// Each must exit with its own validation error, not crash for another reason.
for (const [name, variable, env] of [
  ["PLAYWRIGHT_TEST=1 refuses to start", "PLAYWRIGHT_TEST", { PLAYWRIGHT_TEST: "1" }],
  ["SCAN_DISABLED=true refuses to start", "SCAN_DISABLED", { SCAN_DISABLED: "true" }],
  ["INNGEST_DEV refuses to start", "INNGEST_DEV", { INNGEST_DEV: "1" }],
]) {
  const proc = start(env);
  try {
    const refused = await refusesToStart(proc, 20_000);
    check(name, refused && proc.output().includes(`${variable} must not`));
  } finally {
    await stop(proc);
  }
}

if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("Production smoke checks passed.");
