// Production-mode smoke test against the standalone build.
//
//   npm run build && node scripts/smoke-production.mjs
//
// Expects a production-shaped environment (https APP_URL, real-looking
// secrets, a migrated DATABASE_URL). Checks response headers, session cookie
// flags, and that test-only switches stop the server from starting. Prints
// check names and pass/fail only, never header or cookie values.
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
const failures = [];

function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
}

function start(extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOSTNAME: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  return { child, exited: () => exited };
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
  if (proc.exited()) return;
  proc.child.kill("SIGTERM");
  await new Promise((r) => proc.child.once("exit", r));
}

const main = start();
try {
  check("server becomes live", await live(60_000));

  const page = await fetch(`${base}/setup`, { redirect: "manual" });
  const csp = page.headers.get("content-security-policy") ?? "";
  const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
  check("page has a Content-Security-Policy", csp.length > 0);
  check("script-src uses a nonce", /'nonce-[^']+'/.test(scriptSrc));
  check("script-src has no unsafe-inline or unsafe-eval", !/unsafe-inline|unsafe-eval/.test(scriptSrc));
  check("frames are denied", page.headers.get("x-frame-options") === "DENY" || /frame-ancestors 'none'/.test(csp));
  check("HSTS is set", /max-age=\d+/.test(page.headers.get("strict-transport-security") ?? ""));
  check("nosniff is set", page.headers.get("x-content-type-options") === "nosniff");
  check("x-powered-by is absent", !page.headers.has("x-powered-by"));

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

for (const [name, env] of [
  ["PLAYWRIGHT_TEST=1 refuses to start", { PLAYWRIGHT_TEST: "1" }],
  ["SCAN_DISABLED=true refuses to start", { SCAN_DISABLED: "true" }],
  ["INNGEST_DEV refuses to start", { INNGEST_DEV: "1" }],
]) {
  const proc = start(env);
  try {
    check(name, !(await live(20_000)));
  } finally {
    await stop(proc);
  }
}

if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("Production smoke checks passed.");
