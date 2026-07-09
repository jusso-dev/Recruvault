import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

/**
 * Unit tests only (`test/unit`). They must not touch a database or the network,
 * so `@/db` is never queried and `server-only` is stubbed (it throws outside an
 * RSC bundle). DB-backed integration tests live in `test/integration` and run
 * via `vitest.integration.config.ts` with Testcontainers.
 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-env.ts"],
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
