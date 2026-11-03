// Browser and HTTP driver for the Compose install proof (scripts/compose-proof.sh).
// Runs inside the proof network against the TLS proxy, as a person would.
// Prints check names and pass/fail only: never tokens, keys, links, or
// passwords.
//
//   node driver.mjs onboard | after-restart | email-down
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";

const APP_URL = required("APP_URL");
const MOCK_RESEND_URL = required("MOCK_RESEND_URL");
const KEY_FILE = `${process.env.STATE_DIR ?? "/state"}/customer-key`;
const failures = [];

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.log(`FAIL driver environment has ${name}`);
    process.exit(1);
  }
  return value;
}

function check(name, ok) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
  return ok;
}

/** Run one step; an exception fails that check without printing its message. */
async function step(name, fn) {
  try {
    return check(name, (await fn()) !== false);
  } catch (error) {
    console.log(`FAIL ${name} (${error?.name ?? "Error"})`);
    failures.push(name);
    return false;
  }
}

const path = (page) => new URL(page.url()).pathname;
const toast = (page) => page.getByRole("button", { name: "Dismiss notification" }).locator("..");

async function waitForMessage(to, subject, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MOCK_RESEND_URL}/proof/messages?to=${encodeURIComponent(to)}`);
    const match = (await res.json()).find((m) => m.subject === subject);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function signIn(page) {
  await page.goto(`${APP_URL}/sign-in`);
  await page.getByLabel("Email").fill(required("PROOF_OWNER_EMAIL"));
  await page.getByLabel("Password").fill(required("PROOF_OWNER_PASSWORD"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function onboard(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = required("PROOF_OWNER_EMAIL");
  const password = required("PROOF_OWNER_PASSWORD");

  await step("fresh install sends visitors to /setup over TLS", async () => {
    await page.goto(APP_URL);
    await page.waitForURL("**/setup");
    await page.getByRole("heading", { name: "Set up your recruiter workspace" }).waitFor();
  });

  await step("owner account is created", async () => {
    await page.getByLabel("First name").fill("Proof");
    await page.getByLabel("Last name").fill("Owner");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create owner account" }).click();
    await page.getByText(/Open the verification link sent to/).waitFor();
  });

  await step("session cookie is Secure and HttpOnly", async () => {
    const cookies = (await context.cookies()).filter((c) => /session_token/.test(c.name));
    return cookies.length > 0 && cookies.every((c) => c.secure && c.httpOnly && c.sameSite !== "None");
  });

  await step("setup cannot continue before email verification", async () => {
    await page.reload();
    await page.getByText(/Open the verification link sent to/).waitFor();
    return (await page.getByLabel("Bootstrap token").count()) === 0;
  });

  let link = null;
  await step("verification email is sent through the Resend API", async () => {
    const message = await waitForMessage(email, "Verify your email: Recruvault");
    link = message?.text.match(/https:\/\/\S+/)?.[0] ?? null;
    return Boolean(message);
  });
  await step("verification link points at the https APP_URL", async () =>
    Boolean(link?.startsWith(`${APP_URL}/api/auth/verify-email?`)),
  );

  await step("verification link signs the owner in and resumes setup", async () => {
    // A fresh browser: the link alone must carry the owner back to step 3.
    await context.clearCookies();
    await page.goto(link);
    await page.waitForURL("**/setup");
    await page.getByLabel("Organisation name").waitFor();
  });

  await page.getByLabel("Organisation name").fill("Compose Proof Workspace");
  await page.getByRole("button", { name: "Generate encryption key" }).click();
  const key = await page.getByLabel("Encryption key", { exact: true }).inputValue();
  await page.getByLabel("Confirm encryption key").fill(key);
  await page.getByRole("checkbox", { name: /saved this encryption key/i }).check();

  await step("wrong bootstrap token is refused", async () => {
    await page.getByLabel("Bootstrap token").fill(randomBytes(32).toString("hex"));
    await page.getByRole("button", { name: "Create organisation" }).click();
    await toast(page).filter({ hasText: /bootstrap token is not valid/i }).waitFor();
    return path(page) === "/setup";
  });

  await step("bootstrap token and customer key enrol the owner", async () => {
    await page.getByLabel("Bootstrap token").fill(required("BOOTSTRAP_TOKEN"));
    await page.getByRole("button", { name: "Create organisation" }).click();
    await page.waitForURL("**/dashboard");
    await writeFile(KEY_FILE, key, { mode: 0o600 });
    await chmod(KEY_FILE, 0o600);
  });

  await step("owner reaches the unlocked dashboard", async () => {
    await page.getByRole("complementary").getByText("Compose Proof Workspace", { exact: true }).waitFor();
  });

  await step("setup closes after the first owner", async () => {
    await page.goto(`${APP_URL}/setup`);
    await page.waitForURL("**/sign-in");
  });
  await context.close();
}

async function afterRestart(browser) {
  const key = (await readFile(KEY_FILE, "utf8")).trim();
  const context = await browser.newContext();
  const page = await context.newPage();

  await step("setup stays closed after restart", async () => {
    await page.goto(`${APP_URL}/setup`);
    await page.waitForURL("**/sign-in");
  });

  await step("new session after restart requires the customer key", async () => {
    await signIn(page);
    await page.waitForURL("**/vault/unlock**");
  });

  await step("wrong customer key is refused", async () => {
    await page.getByLabel("Encryption key").fill(randomBytes(32).toString("base64url"));
    await page.getByRole("button", { name: "Unlock vault" }).click();
    await toast(page).filter({ hasText: /does not match/i }).waitFor();
    return path(page) === "/vault/unlock";
  });

  await step("customer key unlocks the dashboard after restart", async () => {
    await page.getByLabel("Encryption key").fill(key);
    await page.getByRole("button", { name: "Unlock vault" }).click();
    await page.waitForURL("**/dashboard");
    await page.getByRole("complementary").getByText("Compose Proof Workspace", { exact: true }).waitFor();
  });
  await context.close();
}

async function emailDown() {
  const email = `proof-${randomBytes(6).toString("hex")}@example.org`;
  const headers = { "content-type": "application/json", origin: APP_URL };
  await step("account sign-up still answers while email is down", async () => {
    const res = await fetch(`${APP_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: randomBytes(18).toString("base64url"), name: "Proof Seeker" }),
    });
    return res.ok;
  });
  await step("verification resend reports failure while email is down", async () => {
    const res = await fetch(`${APP_URL}/api/auth/send-verification-email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
    return res.status >= 500;
  });
}

const command = process.argv[2];
const browser = command === "email-down" ? null : await chromium.launch();
try {
  if (command === "onboard") await onboard(browser);
  else if (command === "after-restart") await afterRestart(browser);
  else if (command === "email-down") await emailDown();
  else check(`driver command ${command ?? "(none)"} is known`, false);
} finally {
  await browser?.close();
}
process.exit(failures.length ? 1 : 0);
