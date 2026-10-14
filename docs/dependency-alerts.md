# Dependency alert register

Every GitHub code-scanning (Trivy) alert raised against this repository, mapped to the version that resolved it or to an explicit unresolved status. Generated from the GitHub code-scanning API and the committed lockfiles on 14 October 2026. Alert states come from scans of the default branch; none were dismissed.

## Unresolved

| Advisory | Package | Path | Status |
| --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (CVE-2026-93687), high | braces 3.0.3 | `package-lock.json` (development: eslint-config-next → fast-glob → micromatch) | No fixed version published. Not in the production image. Lint runs only on repository content. Tracked in [#36](https://github.com/jusso-dev/Recruvault/issues/36). Earlier Trivy runs used `ignore-unfixed`, so it never appeared as an alert; the report scan now includes unfixed and development findings. |

## Resolved

| Alert | Advisory | Severity | Lockfile | Package | Vulnerable | Fixed in | Now locked | Closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | CVE-2026-13149 | medium | `package-lock.json` | brace-expansion | 2.1.1 | 5.0.7, 1.1.16, 2.1.2 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #2 | CVE-2026-16221 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.3, 3.1.4, 4.1.1 | 3.1.8 | 2026-10-14 |
| #3 | CVE-2026-14257 | high | `package-lock.json` | brace-expansion | 2.1.1 | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #4 | CVE-2026-14257 | high | `package-lock.json` | brace-expansion | 5.0.7 | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #5 | CVE-2026-16221 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.3, 3.1.4, 4.1.1 | 3.1.8 | 2026-10-14 |
| #6 | CVE-2026-64641 | high | `package-lock.json` | next | 16.2.10 | 15.5.21, 16.2.11 | 16.4.0 | 2026-10-14 |
| #7 | CVE-2026-64642 | high | `package-lock.json` | next | 16.2.10 | 16.2.11 | 16.4.0 | 2026-10-14 |
| #8 | CVE-2026-64645 | high | `package-lock.json` | next | 16.2.10 | 15.5.21, 16.2.11 | 16.4.0 | 2026-10-14 |
| #9 | CVE-2026-64649 | high | `package-lock.json` | next | 16.2.10 | 15.5.21, 16.2.11 | 16.4.0 | 2026-10-14 |
| #10 | CVE-2026-45623 | high | `package-lock.json` | postcss | 8.4.31 | 8.5.12 | 8.5.23, 8.5.30 | 2026-10-14 |
| #11 | GHSA-r28c-9q8g-f849 | high | `package-lock.json` | postcss | 8.4.31 | 8.5.18 | 8.5.23, 8.5.30 | 2026-08-17 |
| #12 | GHSA-r28c-9q8g-f849 | high | `package-lock.json` | postcss | 8.5.16 | 8.5.18 | 8.5.23, 8.5.30 | 2026-08-17 |
| #13 | GHSA-f88m-g3jw-g9cj | high | `package-lock.json` | sharp | 0.34.5 | 0.35.0 | 0.35.5 | 2026-10-14 |
| #14 | CVE-2026-18446 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.4, 3.1.5, 4.1.2 | 3.1.8 | 2026-10-14 |
| #15 | CVE-2026-69192 | high | `mcp/package-lock.json` | ip-address | 10.2.0 | 10.3.1 | 10.7.4 | 2026-10-14 |
| #16 | CVE-2026-69152 | high | `package-lock.json` | brace-expansion | 2.1.1 | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #17 | CVE-2026-69152 | high | `package-lock.json` | brace-expansion | 5.0.7 | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #18 | CVE-2026-18446 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.4, 3.1.5, 4.1.2 | 3.1.8 | 2026-10-14 |
| #19 | CVE-2026-67213 | medium | `package-lock.json` | nanoid | 3.3.15 | 3.3.18, 5.1.6 | 3.3.20 | 2026-10-14 |
| #20 | CVE-2026-67214 | medium | `package-lock.json` | nanoid | 3.3.15 | 3.3.16, 5.1.16 | 3.3.20 | 2026-10-14 |
| #21 | CVE-2026-73646 | high | `package-lock.json` | postcss | 8.4.31 | 8.5.18 | 8.5.23, 8.5.30 | 2026-10-14 |
| #22 | CVE-2026-73646 | high | `package-lock.json` | postcss | 8.5.16 | 8.5.18 | 8.5.23, 8.5.30 | 2026-10-14 |
| #23 | CVE-2026-75899 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #24 | CVE-2026-75931 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #25 | CVE-2026-75975 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #26 | CVE-2026-76172 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #27 | CVE-2026-73088 | high | `package-lock.json` | browserslist | 4.28.5 | 4.28.7 | 4.29.3 | 2026-10-14 |
| #28 | CVE-2026-73089 | high | `package-lock.json` | browserslist | 4.28.5 | 4.28.7 | 4.29.3 | 2026-10-14 |
| #29 | CVE-2026-75899 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #30 | CVE-2026-75931 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #31 | CVE-2026-75975 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #32 | CVE-2026-76172 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.5, 3.1.6, 4.1.3 | 3.1.8 | 2026-10-14 |
| #33 | CVE-2026-75604 | critical | `package-lock.json` | next | 16.2.10 | 15.5.24, 16.3.3 | 16.4.0 | 2026-10-14 |
| #34 | GHSA-2xp9-vwfh-vxw4 | critical | `package-lock.json` | next | 16.2.10 | 15.5.24, 16.3.3 | 16.4.0 | 2026-10-14 |
| #35 | GHSA-rgj7-g3m4-5g8c | high | `package-lock.json` | sharp | 0.34.5 | 0.35.4 | 0.35.5 | 2026-10-14 |
| #36 | CVE-2026-84292 | high | `mcp/package-lock.json` | fast-uri | 3.1.3 | 2.4.6, 3.1.7, 4.1.4 | 3.1.8 | 2026-10-14 |
| #37 | CVE-2026-101916 | high | `package-lock.json` | @grpc/grpc-js | 1.14.4 | 1.13.6, 1.14.5 | 1.14.6 | 2026-10-14 |
| #38 | CVE-2026-102276 | high | `package-lock.json` | brace-expansion | 2.1.1 | 5.0.10, 3.0.7, 2.1.5, 1.1.19 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #39 | CVE-2026-102278 | high | `package-lock.json` | brace-expansion | 2.1.1 | 5.0.11, 3.0.8, 2.1.6, 1.1.20 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #40 | CVE-2026-102276 | high | `package-lock.json` | brace-expansion | 5.0.7 | 5.0.10, 3.0.7, 2.1.5, 1.1.19 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #41 | CVE-2026-102278 | high | `package-lock.json` | brace-expansion | 5.0.7 | 5.0.11, 3.0.8, 2.1.6, 1.1.20 | 1.1.21, 2.1.7, 5.0.12 | 2026-10-14 |
| #42 | CVE-2026-84292 | high | `package-lock.json` | fast-uri | 3.1.3 | 2.4.6, 3.1.7, 4.1.4 | 3.1.8 | 2026-10-14 |
| #43 | GHSA-vcvr-r3jv-pc5j | critical | `package-lock.json` | next | 16.2.10 | 16.3.6 | 16.4.0 | 2026-10-14 |
| #44 | CVE-2026-104850 | high | `mcp/package-lock.json` | @modelcontextprotocol/sdk | 1.29.0 | 1.31.0 | 1.32.1 | 2026-10-14 |
| #45 | CVE-2026-90711 | critical | `mcp/package-lock.json` | proxy-addr | 2.0.7 | 2.0.8 | 2.0.8 | 2026-10-14 |
| #46 | CVE-2026-94483 | medium | `package-lock.json` | next | 16.2.10 | 16.3.8 | 16.4.0 | 2026-10-14 |
| #47 | GHSA-wq5f-xc86-pv6w | high | `package-lock.json` | sharp | 0.34.5 | 0.35.5 | 0.35.5 | 2026-10-14 |
| #48 | CVE-2026-93749 | high | `package-lock.json` | source-map-js | 1.2.1 | 1.2.2 | 1.2.2 | 2026-10-14 |

To refresh this register, list alerts with `gh api --paginate repos/jusso-dev/Recruvault/code-scanning/alerts` and compare against `npm ls <package>` for both lockfiles. Do not dismiss an alert to make the register look clean.
