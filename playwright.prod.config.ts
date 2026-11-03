import { defineConfig, devices } from "@playwright/test";

// Browser checks against the standalone production build (npm run build).
// Unlike playwright.config.ts this never loads .env files and never enables
// the test mailbox, scanner bypass, or Inngest dev server: production refuses
// all three. The caller provides a production-shaped environment (see the
// production-smoke job in .github/workflows/ci.yml).
//
// The app is served on localhost so the browser accepts its Secure cookies
// over plain HTTP. The spec serves cross-origin probe pages from 127.0.0.1 on
// port + 7 (an allowed API origin) and port + 8 (not allowed).
const port = Number(process.env.PROD_E2E_PORT ?? 3110);
const PROD_BASE_URL = `http://localhost:${port}`;
const PROD_API_ORIGIN = `http://127.0.0.1:${port + 7}`;

export default defineConfig({
  testDir: "./e2e-prod",
  outputDir: "./test-results/playwright-prod",
  globalSetup: "./e2e-prod/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 12_000 },
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    baseURL: PROD_BASE_URL,
    ...devices["Desktop Chrome"],
    // Pages show encryption keys and session state: keep no browser artifacts.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    name: "Recruvault (production)",
    command: "node scripts/start-standalone.mjs",
    url: `${PROD_BASE_URL}/api/live`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      // Playwright sets PLAYWRIGHT_TEST=1 for its own processes and the web
      // server inherits it; production refuses to start with it.
      PLAYWRIGHT_TEST: "",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      // The only browser origin allowed to call /api/v1 in these tests.
      API_CORS_ORIGINS: PROD_API_ORIGIN,
      // The clamd stand-in started by e2e-prod/global-setup.ts.
      CLAMAV_HOST: "127.0.0.1",
      CLAMAV_PORT: String(port + 9),
    },
    stdout: "ignore",
    stderr: "pipe",
  },
});
