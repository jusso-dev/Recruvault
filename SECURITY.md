# Security maintenance

Recruvault handles candidate career documents and self-declared clearance
information. It must not collect classified material, identity documents,
right-to-work evidence, or police-check documents. The
[release checklist](https://github.com/jusso-dev/Recruvault/issues/37) records
security requirements that are still open. Customer keys are enrolled per organisation and job seeker. The server can unwrap a key while that session or API credential is unlocked. A database copy without the unlock secret does not reveal new envelopes. Legacy rows and secure-link render delegation still depend on `LOCAL_KEK`. Details and the restore procedure are in [docs/encryption.md](docs/encryption.md) and [docs/operations.md](docs/operations.md).

## Dependency updates

Use the committed npm lockfiles for both the application and `mcp/`. Docker
builds use `npm ci` and must fail on installation errors. Environment files
are excluded from the Docker context; supply deployment secrets at runtime.
Both runtime images patch Alpine packages and omit npm, Yarn, and Corepack.
The Railway image retains only the installed dependency closure needed for
migration/seeding, plus the traced app dependencies. It invokes tool entry
points with Node and excludes unrelated development tools such as Inngest CLI
and ESLint. Scan both final images as well as the development lockfile.

Run the following after dependency changes:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm audit
npm audit --omit=dev
npm --prefix mcp ci
npm --prefix mcp audit
node --check mcp/index.mjs
npm --prefix mcp test
```

Integration tests use a disposable PostgreSQL database: set
`INTEGRATION_DATABASE_URL` to an admin connection on a throwaway server, or let
them start a Testcontainers PostgreSQL (requires Docker). A suite that cannot
reach its database fails rather than skipping.

CI runs lint, typecheck, unit tests, the migration drift check, a production
build, the PostgreSQL/object-store integration suites, the browser suite, a
production-mode smoke test (`scripts/smoke-production.mjs`: security headers,
secure session cookies, and refusal to start with test switches), and the MCP
audit. CI audits runtime dependencies and reports the full development audit.
Trivy scans both lockfiles including development dependencies and the
`runner`, `migrate`, and Railway images. It uploads every high/critical
finding, including unfixed ones, to code scanning and fails only on findings
that have a fixed version. The image job also fails if any layer contains an
`.env` file. Base images and Compose services are pinned by digest.
Dependabot covers both npm projects, GitHub Actions, Dockerfiles, and Compose.
Repository-level alert settings are separate from this configuration.

[docs/dependency-alerts.md](docs/dependency-alerts.md) maps every code-scanning
alert to the version that fixed it or to its unresolved status.

## Temporary dependency overrides

- esbuild is pinned to 0.28.2 to avoid the legacy version pulled by
  `@esbuild-kit/core-utils` and
  [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
  Drizzle Kit still declares the legacy loader dependency. Check TypeScript
  configuration loading, migration generation, and migration execution when
  changing this override. The same version also satisfies the current Vite
  optional peer dependency; validate the test runner and build tools together.
- `inngest-cli` uses adm-zip 0.6.1, which includes fixes for known archive
  allocation, extraction, and decompression advisories. Check the CLI installer
  and CLI launch when changing this override.

The adm-zip override is limited to Inngest CLI. Remove the esbuild override
once Drizzle's legacy loader dependency is removed or updated, and remove
the adm-zip override once its maintained upstream dependency range resolves to a
patched version. Do not apply `npm audit fix --force` without reviewing the
proposed changes; it can suggest incompatible downgrades of Next.js lint
configuration and database tooling.

## Unresolved upstream findings

As assessed on 14 October 2026, braces 3.0.3 has a high-severity
[stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(CVE-2026-93687) with no published fixed version. The dependency is used by
Next.js ESLint tooling through fast-glob and micromatch. Lint only trusted
repository inputs; this restriction is a mitigation, not a fix. A full npm
audit can report several affected packages along that dependency chain.

Track this and other scan findings in
[the dependency-remediation issue](https://github.com/jusso-dev/Recruvault/issues/36).
Do not dismiss GitHub alerts or suppress audit output to represent an unfixed
dependency as secure. Re-check official Next.js security announcements and
the npm stable tag immediately before deployment, including security releases
announced but not yet published at the time of an earlier upgrade.

GitHub alert status reflects scans of committed branches. A successful local
audit does not close default-branch alerts until the fixes are merged and
scanned.
