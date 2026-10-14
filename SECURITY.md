# Security maintenance

Recruvault handles candidate career documents and self-declared clearance
information. It must not collect classified material, identity documents,
right-to-work evidence, or police-check documents. The
[release checklist](https://github.com/jusso-dev/Recruvault/issues/37) records
security requirements that are still open. Current server-side encryption is
not a zero-knowledge or customer-key system.

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
```

Integration tests require a working Docker runtime and use disposable
PostgreSQL containers. Also run migration drift checks, the browser suite in
isolated infrastructure, and Trivy against both lockfiles and built images.
CI audits application runtime and MCP dependencies; Trivy rejects fixable
high/critical findings and uploads SARIF even when its scan fails. Dependabot
configuration covers both npm projects and GitHub Actions. Repository-level
alert settings are separate from this configuration.

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
