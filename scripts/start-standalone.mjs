// Start the standalone production server the way the Docker image does:
// static assets and public files copied beside server.js, NODE_ENV=production.
//
//   npm run build && node scripts/start-standalone.mjs
//
// Used by playwright.prod.config.ts. PORT and HOSTNAME come from the caller.
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const dist = process.env.NEXT_DIST_DIR ?? ".next";
const standalone = path.join(dist, "standalone");
const server = path.join(standalone, "server.js");
if (!existsSync(server)) {
  console.error(`Missing ${server}. Run npm run build first.`);
  process.exit(1);
}

cpSync(path.join(dist, "static"), path.join(standalone, dist, "static"), { recursive: true });
cpSync("public", path.join(standalone, "public"), { recursive: true });

const child = spawn(process.execPath, [server], {
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
