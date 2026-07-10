import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

// Keep browser tests off the ordinary development port so the suite always
// launches with its test mailbox, scanner, and Inngest configuration.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const serverURL = new URL(baseURL);
const serverHostname = serverURL.hostname;
const serverPort = serverURL.port || (serverURL.protocol === "https:" ? "443" : "80");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/playwright",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      name: "Recruvault",
      command: `npm run dev -- --hostname ${serverHostname} --port ${serverPort}`,
      url: baseURL,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        APP_URL: baseURL,
        ALLOW_RECRUITER_SIGNUP: "true",
        INNGEST_DEV: "http://127.0.0.1:8289",
        NEXT_DIST_DIR: ".next-e2e",
        RESEND_API_KEY: "",
        SCAN_DISABLED: "true",
        PLAYWRIGHT_TEST: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "Inngest",
      command:
        `npx inngest dev --no-discovery --sdk-url ${baseURL}/api/inngest --port 8289`,
      url: "http://127.0.0.1:8289",
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
