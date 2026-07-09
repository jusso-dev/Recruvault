import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

/**
 * DB-backed integration tests. These spin a throwaway Postgres via
 * Testcontainers (Docker required) and exercise the real envelope-encryption
 * and crypto-shred paths end to end. Run with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
