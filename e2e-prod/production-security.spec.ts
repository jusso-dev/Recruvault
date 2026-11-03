import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Client, type QueryResultRow } from "pg";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Runs against the standalone build with NODE_ENV=production (see
// playwright.prod.config.ts). Every page visit records CSP violations, CSP
// console errors, hydration errors, and uncaught exceptions; each test fails
// if any were seen.

const port = Number(process.env.PROD_E2E_PORT ?? 3110);
const BASE = `http://localhost:${port}`;
// Cross-origin probe pages; port + 7 is in API_CORS_ORIGINS, port + 8 is not.
const ALLOWED_ORIGIN = `http://127.0.0.1:${port + 7}`;
const OTHER_ORIGIN = `http://127.0.0.1:${port + 8}`;
const APP_ORIGIN = new URL(process.env.APP_URL!).origin;

test.describe.configure({ mode: "serial" });

async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query<T>(text, values);
  } finally {
    await client.end();
  }
}

type Problem = { kind: string; detail: string };

/** Record CSP violations and errors for every document loaded in the context. */
async function watch(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        sample: e.sample.slice(0, 80),
        source: `${e.sourceFile}:${e.lineNumber}`,
      });
    });
  });
}

function track(page: Page) {
  const problems: Problem[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content.Security.Policy|Refused to (load|execute|apply|frame|connect)|hydrat/i.test(text)) {
      problems.push({ kind: `console.${message.type()}`, detail: text.slice(0, 300) });
    }
  });
  page.on("pageerror", (error) => problems.push({ kind: "pageerror", detail: error.message.slice(0, 300) }));
  return problems;
}

async function violations(page: Page) {
  return page.evaluate(() => (window as unknown as { __csp?: unknown[] }).__csp ?? []);
}

async function expectClean(page: Page, problems: Problem[]) {
  expect(await violations(page), `CSP violations on ${page.url()}`).toEqual([]);
  expect(problems, `console/page errors on ${page.url()}`).toEqual([]);
}

/** React attaches its fiber to every hydrated host node. */
async function expectHydrated(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => Object.keys(document.body).some((key) => key.startsWith("__reactFiber$"))),
    )
    .toBe(true);
}

async function visit(page: Page, problems: Problem[], path: string) {
  const response = await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expectHydrated(page);
  await expectClean(page, problems);
  return response;
}

function nonceOf(csp: string | null) {
  return /'nonce-([^']+)'/.exec(csp ?? "")?.[1] ?? "";
}

/** Sign up through the auth API as a non-browser client and return its cookies. */
async function apiSignUp(email: string) {
  const response = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({
      email,
      password: randomBytes(18).toString("base64url"),
      name: "Production Check",
    }),
  });
  expect(response.status).toBe(200);
  // Email delivery is not available here; the verified flag stands in for the link.
  await query(`update "user" set email_verified = true where email = $1`, [email]);
  return response.headers.getSetCookie().map((header) => {
    const pair = header.split(";")[0];
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1) };
  });
}

async function addCookies(context: BrowserContext, cookies: { name: string; value: string }[]) {
  await context.addCookies(
    cookies.map((cookie) => ({
      ...cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    })),
  );
}

function cookieHeader(cookies: { name: string; value: string }[]) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function fillEncryptionKey(page: Page) {
  await page.getByRole("button", { name: "Generate encryption key" }).click();
  const key = await page.getByLabel("Encryption key", { exact: true }).inputValue();
  await page.getByLabel("Confirm encryption key").fill(key);
  await page.getByRole("checkbox", { name: /saved this encryption key/i }).check();
}

async function jdPdf() {
  const pdf = await PDFDocument.create();
  const pageDoc = pdf.addPage([595, 842]);
  pageDoc.drawText("Production CSP check job description", {
    x: 48,
    y: 780,
    size: 14,
    font: await pdf.embedFont(StandardFonts.Helvetica),
  });
  return Buffer.from(await pdf.save());
}

/**
 * A real loopback HTTP origin serving fixed HTML. Pages synthesised with
 * page.route count as a public address space, and Chromium's local network
 * access checks would then block every request to the app for that reason
 * instead of the app's own headers.
 */
async function probeOrigin(origin: string, pages: Record<string, string>) {
  const server = createServer((req, res) => {
    const body = pages[req.url ?? ""];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" });
    res.end(body ?? "");
  });
  const { hostname, port: listenPort } = new URL(origin);
  await new Promise<void>((resolve) => server.listen(Number(listenPort), hostname, resolve));
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

let ownerCookies: { name: string; value: string }[] = [];
let jdDocumentId = "";

test("page responses carry a fresh nonce and are never cached", async ({ request }) => {
  const first = await request.get("/setup");
  const second = await request.get("/setup");
  const [a, b] = [first.headers()["content-security-policy"], second.headers()["content-security-policy"]];
  expect(nonceOf(a)).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
  expect(nonceOf(a)).not.toBe(nonceOf(b));

  for (const response of [first, second]) {
    const nonce = nonceOf(response.headers()["content-security-policy"]);
    const html = await response.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(response.headers()["cache-control"]).toMatch(/private/);
    expect(response.headers()["cache-control"]).toMatch(/no-store/);
    expect(response.headers()["x-nextjs-cache"]).toBeUndefined();
  }
  expect(await second.text()).not.toContain(nonceOf(first.headers()["content-security-policy"]));
});

test("first-run setup hydrates and runs client validation with no CSP violations", async ({ context, page }) => {
  await watch(context);
  const problems = track(page);
  await visit(page, problems, "/setup");

  await page.getByLabel("First name").fill("Casey");
  await page.getByLabel("Last name").fill("Ward");
  await page.getByLabel("Work email").fill("not-submitted@example.org");
  await page.getByLabel("Password", { exact: true }).fill("Correct-horse-1");
  await page.getByLabel("Confirm password").fill("Different-horse-2");
  await page.getByRole("button", { name: /create owner account/i }).click();
  await expect(page.getByText("The passwords do not match")).toBeVisible();
  await expectClean(page, problems);

  // The API reference is plain HTML with no React tree; only the CSP checks apply.
  await page.goto("/api/v1/docs");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "openapi.json" })).toBeVisible();
  await expectClean(page, problems);
});

test("injected inline scripts and unapproved script origins are blocked", async ({ context, page }) => {
  await watch(context);
  const problems = track(page);
  // Simulate stored or reflected HTML injection: the attacker controls markup
  // in the server response but cannot read the per-response nonce.
  const injected = [
    `<script>window.__inlineRan = true</script>`,
    `<script nonce="Z3Vlc3NlZC1ub25jZQ==">window.__guessedNonceRan = true</script>`,
    `<script src="https://cdn.attacker.example/payload.js"></script>`,
    `<script src="/injected-same-origin.js"></script>`,
    `<img alt="" src="data:image/png;base64,AAAA" onerror="window.__handlerRan = true">`,
  ].join("");
  await page.route("https://cdn.attacker.example/payload.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.__externalRan = true" }),
  );
  await page.route(`${BASE}/injected-same-origin.js`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.__sameOriginRan = true" }),
  );
  await page.route(`${BASE}/setup`, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("</body>", `${injected}</body>`);
    await route.fulfill({ response, body });
  });

  const response = await page.goto("/setup");
  expect(response?.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  await page.waitForLoadState("networkidle");
  // The legitimate, nonced application scripts still run.
  await expectHydrated(page);
  // A DOM XSS sink after hydration. (Scripts inserted by page.evaluate are
  // not a fair probe: DevTools-originated insertion is exempt from CSP.)
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<img alt="" src="data:image/png;base64,AAAA" onerror="window.__sinkHandlerRan = true">`,
    );
  });
  await page.waitForTimeout(250);

  const ran = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return [
      "__inlineRan",
      "__guessedNonceRan",
      "__externalRan",
      "__sameOriginRan",
      "__handlerRan",
      "__sinkHandlerRan",
    ].filter((flag) => w[flag]);
  });
  expect(ran).toEqual([]);

  const seen = (await violations(page)) as { directive: string; blocked: string }[];
  expect(seen.some((v) => v.directive === "script-src-elem" && v.blocked === "inline")).toBe(true);
  expect(seen.some((v) => v.blocked.startsWith("https://cdn.attacker.example/"))).toBe(true);
  expect(seen.some((v) => v.blocked.endsWith("/injected-same-origin.js"))).toBe(true);
  expect(seen.some((v) => v.directive === "script-src-attr")).toBe(true);
  expect(problems.filter((p) => p.kind === "pageerror")).toEqual([]);
});

test("owner setup, dashboard navigation, and error boundaries run under the enforced policy", async ({
  context,
  page,
  request,
}) => {
  await watch(context);
  const problems = track(page);
  const email = `owner-${randomBytes(5).toString("hex")}@example.org`;
  ownerCookies = await apiSignUp(email);
  await addCookies(context, ownerCookies);

  await visit(page, problems, "/setup");
  await page.getByLabel("Organisation name").fill("Production CSP Check");
  await page.getByLabel("Bootstrap token").fill(process.env.BOOTSTRAP_TOKEN!);
  await fillEncryptionKey(page);
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL("**/dashboard");
  await expectHydrated(page);
  await expectClean(page, problems);
  // Setup also unlocked the vault for this session; later tests reuse both.
  ownerCookies = (await context.cookies()).map(({ name, value }) => ({ name, value }));

  // Client-side navigation through nested routes.
  for (const [label, path] of [
    ["New role", "/dashboard/requests/new"],
    ["Matched alerts", "/dashboard/job-alerts"],
    ["API & MCP", "/dashboard/integrations"],
    ["Audit trail", "/dashboard/audit"],
    ["Settings", "/dashboard/settings"],
    ["Dashboard", "/dashboard"],
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await page.waitForURL(`**${path}`);
    await page.waitForLoadState("networkidle");
    await expectClean(page, problems);
  }

  // Full loads, an unknown role (not-found), a malformed id (error boundary),
  // and an unknown top-level path (root not-found).
  for (const path of ["/dashboard/settings", `/dashboard/requests/${crypto.randomUUID()}`]) {
    await visit(page, problems, path);
  }
  await visit(page, problems, "/dashboard/requests/not-a-uuid");
  const missing = await visit(page, problems, `/no-such-page-${randomBytes(3).toString("hex")}`);
  expect(missing?.status()).toBe(404);
  expect(missing?.headers()["content-security-policy"]).toContain("'nonce-");

  // Authenticated HTML: fresh nonce per response, never stored by caches,
  // and an anonymous request never receives the owner's page.
  const headers = { cookie: cookieHeader(ownerCookies) };
  const one = await request.get("/dashboard", { headers, maxRedirects: 0 });
  const two = await request.get("/dashboard", { headers, maxRedirects: 0 });
  expect(one.status(), one.headers()["location"]).toBe(200);
  expect(nonceOf(one.headers()["content-security-policy"])).not.toBe(
    nonceOf(two.headers()["content-security-policy"]),
  );
  expect(one.headers()["cache-control"]).toMatch(/private.*no-store|no-store.*private/);
  const anonymous = await request.get("/dashboard", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers()["location"]).toContain("/sign-in");
});

test("role with a PDF job description can be created", async ({ context, page }) => {
  await watch(context);
  const problems = track(page);
  await addCookies(context, ownerCookies);
  await visit(page, problems, "/dashboard/requests/new");
  const title = `CSP check role ${randomBytes(3).toString("hex")}`;
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description (shown to the candidate)").fill("Role used by the production CSP check.");
  await page.getByLabel(/Job description \(PDF/).setInputFiles({
    name: "csp-check-jd.pdf",
    mimeType: "application/pdf",
    buffer: await jdPdf(),
  });
  await page.getByRole("button", { name: "Create role" }).click();
  await page.waitForURL(/\/dashboard\/requests\/[0-9a-f-]+$/);
  await expectHydrated(page);
  await expectClean(page, problems);

  const { rows } = await query<{ jd: string }>(
    `select jd_document_id as jd from requests where title = $1`,
    [title],
  );
  jdDocumentId = rows[0]?.jd ?? "";
  expect(jdDocumentId).not.toBe("");
});

test("authorised responder sees the job description PDF in a same-origin frame", async ({ context, page }) => {
  test.skip(!jdDocumentId, "needs the role from the previous test");
  await watch(context);
  const problems = track(page);

  // A verified secure link. OTP delivery needs email, which production cannot
  // fake; the link session cookie is what OTP verification would issue.
  const rawToken = randomBytes(32).toString("base64url");
  const { rows } = await query<{ id: string }>(
    `insert into access_tokens (request_id, token_hash, recipient_email, expires_at, verified_at)
     select id, $2, 'responder@example.org', now() + interval '2 days', now()
     from requests where jd_document_id = $1 returning id`,
    [jdDocumentId, createHash("sha256").update(rawToken).digest("hex")],
  );
  const payload = `${rows[0].id}.${Date.now() + 30 * 60 * 1000}`;
  const secret = process.env.LINK_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET!;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  await addCookies(context, [{ name: "rv_link_session", value: `${payload}.${signature}` }]);

  const viewPath = `/api/documents/${jdDocumentId}/view`;
  const framed = page.waitForResponse((response) => response.url() === `${BASE}${viewPath}`);
  await visit(page, problems, `/r/${rawToken}/respond`);
  const pdf = await framed;
  expect(pdf.status()).toBe(200);
  expect(pdf.request().frame()).not.toBe(page.mainFrame());
  const headers = pdf.headers();
  expect(headers["content-type"]).toBe("application/pdf");
  expect(headers["content-disposition"]).toMatch(/^inline; filename="/);
  expect(headers["cache-control"]).toBe("private, no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  await expectClean(page, problems);

  // The document is served only through the authorised route: the page
  // carries no object-store or blob URL for it.
  const html = await page.content();
  expect(html).not.toMatch(/X-Amz-|s3\.amazonaws|blob:/);
});

test("other origins cannot frame the app, the API reference, or documents", async ({ page }) => {
  const targets = [
    `${BASE}/sign-in`,
    `${BASE}/api/v1/docs`,
    `${BASE}/api/documents/${jdDocumentId || crypto.randomUUID()}/view`,
    // Control: a cross-origin loopback frame that sends no framing headers.
    `${OTHER_ORIGIN}/control`,
  ];
  const stopFramer = await probeOrigin(ALLOWED_ORIGIN, {
    "/frame-probe": targets.map((src) => `<iframe src="${src}"></iframe>`).join(""),
  });
  const stopControl = await probeOrigin(OTHER_ORIGIN, { "/control": "<p>control</p>" });
  try {
    await page.goto(`${ALLOWED_ORIGIN}/frame-probe`);
    await page.waitForLoadState("networkidle");
    const frameUrls = async () =>
      Promise.all(
        targets.map(async (_, index) => {
          const handle = await page.locator("iframe").nth(index).elementHandle();
          return (await handle?.contentFrame())?.url() ?? "";
        }),
      );
    // Chromium replaces a frame refused by frame-ancestors or X-Frame-Options
    // with its error page.
    await expect
      .poll(frameUrls)
      .toEqual([
        "chrome-error://chromewebdata/",
        "chrome-error://chromewebdata/",
        "chrome-error://chromewebdata/",
        `${OTHER_ORIGIN}/control`,
      ]);
  } finally {
    await stopFramer();
    await stopControl();
  }
});

test("cross-origin browser requests follow the documented API CORS policy", async ({ page }) => {
  const stops = await Promise.all(
    [ALLOWED_ORIGIN, OTHER_ORIGIN].map((origin) => probeOrigin(origin, { "/cors-probe": "<p>probe</p>" })),
  );
  const network: string[] = [];
  page.on("console", (message) => {
    if (/address space|Private Network|local network/i.test(message.text())) network.push(message.text());
  });

  const probe = (target: Page) =>
    target.evaluate(async (base) => {
      const attempt = async (path: string, init?: RequestInit) => {
        try {
          const response = await fetch(`${base}${path}`, init);
          return response.status;
        } catch {
          return "blocked";
        }
      };
      const json = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
      return {
        openapi: await attempt("/api/v1/openapi.json"),
        bearer: await attempt("/api/v1/me/profile", { headers: { authorization: "Bearer rv_invalid" } }),
        session: await attempt("/api/auth/get-session"),
        signIn: await attempt("/api/auth/sign-in/email", json),
        webhook: await attempt("/api/webhooks/resend", json),
        document: await attempt(`/api/documents/${crypto.randomUUID()}/view`),
        wallet: await attempt(`/api/wallet/documents/${crypto.randomUUID()}/view`),
      };
    }, BASE);

  try {
    // From an allowed origin the versioned API is readable, including a
    // preflighted bearer request; auth, webhook, and document routes are not.
    await page.goto(`${ALLOWED_ORIGIN}/cors-probe`);
    expect(await probe(page)).toEqual({
      openapi: 200,
      bearer: 401,
      session: "blocked",
      signIn: "blocked",
      webhook: "blocked",
      document: "blocked",
      wallet: "blocked",
    });

    await page.goto(`${OTHER_ORIGIN}/cors-probe`);
    expect(await probe(page)).toEqual({
      openapi: "blocked",
      bearer: "blocked",
      session: "blocked",
      signIn: "blocked",
      webhook: "blocked",
      document: "blocked",
      wallet: "blocked",
    });
    // Every refusal above came from the app's CORS headers.
    expect(network).toEqual([]);
  } finally {
    await Promise.all(stops.map((stop) => stop()));
  }
});
