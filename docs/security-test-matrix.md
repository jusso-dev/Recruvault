# Security test matrix

This is the release-gating authorisation matrix for issue #35. It maps every sensitive target against every principal and credential, the expected result, and the test that proves it. Tests send direct requests: Server Actions are POSTed with their action id, REST routes get raw `Authorization` headers, and document, export, and link routes get the cookies a browser would hold. No row here is proven by clicking through the UI alone.

## How the browser matrix works

`e2e/security-matrix.spec.ts` runs in the `e2e` CI job against the development server, PostgreSQL, MinIO, and Inngest dev, after `e2e/recruvault.spec.ts`.

- **Principals** are real accounts created over HTTP: sign-up through `/api/auth/sign-up/email`, the emailed verification link from the test mailbox, then Server Actions for organisation creation, membership, and vault enrolment or unlock. Each principal is a Playwright `APIRequestContext` holding only its own cookies.
- **Server Actions** are found in the build's `server-reference-manifest.json` files (`e2e/security-helpers.ts`). The manifests list every export of each `"use server"` module a page loads, whether or not that page's UI calls it, so this is the surface an attacker can reach. The helper POSTs `Next-Action: <id>` with React's reply encoding and parses the returned value or thrown error from the RSC response.
- **Inventory check.** The test `the matrix names every Server Action in the source and the build` parses every `"use server"` module under `src/` and fails if an export is missing from the matrix, or if a matrix action has no live action id. A new action cannot ship without a row.
- **Denials** are asserted on status and on the body: no customer key, API key, document marker, field marker, or other-tenant title may appear in a refused response. For Server Actions, a per-action state snapshot (membership role, request status, share count, row counts, and so on) must be unchanged after all denied calls.
- **Allowed paths** are exercised too: every fixture is created by the principal that is allowed to create it, through the same direct requests, so a denial cannot pass because the target never worked.
- Test data is synthetic (`sm-*-<run>@e2e.recruvault.test`, random markers and keys per run). Global setup refuses a non-local database. CI uploads no traces, screenshots, or videos.

Integration suites in `test/integration` cover what needs fault injection or production-mode configuration. They call Server Actions and route handlers in-process with a forged request context (`test/integration/request-context.ts`) against real PostgreSQL and MinIO.

## Principals and credentials

| Label | What it is | How it is made |
| --- | --- | --- |
| anonymous | No cookies, no key | Fresh request context |
| forgedCookie | A session cookie with an invalid value | Cookie header only. Passes the proxy's presence check so the data layer is tested |
| ownerAExpired, seekerAExpired | A real session whose row has expired | Sign in, then `session.expires_at` set in the past |
| ownerARevoked, seekerARevoked | A session cookie replayed after sign-out | Sign in, save cookies, `POST /api/auth/sign-out`, replay |
| unverifiedOrg | Organisation account that never opened the verification link | Sign-up session only |
| orglessOrg | Verified organisation account with no membership (the onboarding state) | Sign-up and verification |
| ownerA | Owner of organisation A, customer key unlocked | `createOrganisation` with a fresh key |
| ownerALocked | ownerA in a second browser that has not unlocked the key | Second sign-in |
| adminA, recruiterA, reviewerA, complianceA | Members of A, each unlocked | `inviteMember` by ownerA, sign-up from the emailed `/invite/<token>` link, verification, `acceptInvitation`, then `unlockVault` |
| inviteeUnverified | Account whose address matches a pending invitation but is not verified | Sign-up only |
| revokedInvitee | Verified account whose invitation ownerA withdrew | `inviteMember`, `revokeInvitation`, sign-up and verification |
| passwordInvitee | Verified account with an open invitation, presenting no or the wrong password | `inviteMember`, sign-up and verification |
| tempAdminA, removedSenderInvitee | An admin who invites someone and is then removed; that invitee, verified | `inviteMember` by tempAdminA, `removeMember` by ownerA |
| ownerB | Owner of organisation B, a separate tenant with its own key | `createOrganisation` |
| seekerA, seekerB | Two unrelated job seekers, each enrolled and unlocked | Sign-up, verification, `enrollVault` |
| seekerALocked | seekerA in a second browser, locked | Second sign-in |
| seekerUnenrolled | Verified job seeker that never saved a key | Sign-up and verification |
| Scoped API keys | One org key per scope (8, including `submissions:write`) and one with all scopes; one seeker key per scope (4) and one with all; recruiterA's all-scope key | `createApiKey`, `createCandidateApiKey` |
| Unusable keys | Expired, revoked, unknown `rv_` key, key without the prefix, `Basic` scheme, empty bearer | Created then expired/revoked, or synthetic |
| Wrong-tenant key | ownerB's all-scope key used on organisation A's ids | `createApiKey` as ownerB |
| Secure links | Applicant (consumed), forwarded, revoked, expired, attempt-exhausted, unknown, forged link-session cookie | `sendRequest` invitations read from the test mailbox |
| Teammate invitations | Accepted (reused), pending, withdrawn, one addressed to a job seeker with a career record | `inviteMember` emails read from the test mailbox |

## Server Actions

All 47 exports of the eleven `"use server"` modules. "Outsiders (org)" is anonymous, forgedCookie, ownerAExpired, ownerARevoked, unverifiedOrg, orglessOrg, and seekerA. "Outsiders (seeker)" is anonymous, forgedCookie, seekerAExpired, seekerARevoked, ownerA, and unverifiedOrg. Every denied call is in `every Server Action refuses every principal without the right`; the allowed column names the test where the permitted principal succeeds.

| Action | Denied (state unchanged) | Allowed, proven in |
| --- | --- | --- |
| createOrganisation | anonymous, forgedCookie, seekerA, unverifiedOrg, ownerA (already a member), ownerAExpired; orglessOrg without, unacknowledged, mismatched, or weak key | ownerA, ownerB: `builds every principal…` |
| inviteMember | Outsiders (org), ownerALocked, recruiterA, reviewerA, complianceA | ownerA and tempAdminA: `builds every principal…` |
| revokeInvitation | Outsiders (org), recruiterA, reviewerA, complianceA, ownerB | ownerA: `builds every principal…` |
| acceptInvitation | anonymous, forgedCookie; inviteeUnverified (address matches, not verified); seekerB, ownerB (another address); seekerA (address matches, holds a career record, account stays a job seeker); orglessOrg and adminA reusing adminA's accepted link; revokedInvitee (withdrawn); passwordInvitee (wrong password); removedSenderInvitee (sender removed). Reason checked; org A and B member counts and account types unchanged. `accepting an invitation needs the account password…` adds no password and the removed sender again | Every member of A: `builds every principal…`; passwordInvitee with the password, which also ends that account's other session: `accepting an invitation needs the account password…` |
| updateMemberRole | Outsiders (org), ownerALocked, recruiterA, reviewerA, complianceA, ownerB | e2e `recruvault.spec.ts` (owner changes a role) |
| removeMember | Outsiders (org), recruiterA, reviewerA, complianceA, ownerB | ownerA removing tempAdminA: `builds every principal…`; `recruvault.spec.ts` |
| updateOrgSettings | Outsiders (org), ownerALocked, recruiterA, reviewerA, complianceA | `recruvault.spec.ts` |
| verifyDomain | Outsiders (org), ownerALocked, recruiterA, reviewerA, complianceA (reason checked) | Not exercised: needs Resend. Guard shared with updateOrgSettings |
| createRequest | Outsiders (org), ownerALocked, reviewerA, complianceA | ownerA, ownerB: `builds every principal…` |
| deleteTemplate | Outsiders (org), reviewerA, complianceA, ownerB | `recruvault.spec.ts` |
| sendRequest | Outsiders (org), ownerALocked, recruiterA (not the role's creator), reviewerA, complianceA, ownerB | ownerA: `builds every principal…` (five invitations) |
| revokeAccessToken | Outsiders (org), recruiterA (not the role's creator), reviewerA, complianceA, ownerB | ownerA: `secure links…` |
| setRequestStatus | Outsiders (org), ownerALocked, recruiterA (not the role's creator), reviewerA, complianceA, ownerB | `recruvault.spec.ts` |
| shareSubmission | Outsiders (org), ownerALocked, recruiterA (not the role's creator, including to themselves), reviewerA, complianceA, ownerB (to its own user) | ownerA: `builds every principal…`, `submission documents and exports…` |
| unshareSubmission | Outsiders (org), recruiterA, reviewerA, complianceA (neither role owner nor admin), ownerB | ownerA: `submission documents and exports…` (reviewer loses access, then regains it on re-share) |
| setSubmissionStatus | Outsiders (org), ownerALocked, reviewerA, recruiterA (not the role's creator), ownerB | `recruvault.spec.ts` |
| deleteSubmission | Outsiders (org), recruiterA, reviewerA, ownerB | `recruvault.spec.ts`; purge mechanics in `erasure-retention.test.ts` |
| updateRecruiterMatchSettings | Outsiders (org), ownerALocked, reviewerA, complianceA | `recruvault.spec.ts` |
| updateBackupSettings, runBackupNow | Outsiders (org), ownerALocked, adminA, recruiterA, reviewerA, complianceA, ownerA and ownerB (not the platform organisation) | Platform owner passes the tenant gate: `tenant-scoped-controls.test.ts`. R2 upload is not exercised in CI |
| createApiKey | Outsiders (org), ownerALocked, reviewerA, complianceA | ownerA, ownerB: `builds every principal…` |
| rotateApiKey | Outsiders (org), adminA, recruiterA, reviewerA, complianceA, ownerB (key still works afterwards) | `api-keys.test.ts`, `api-key-recent-auth.test.ts` |
| revokeApiKey | Outsiders (org), recruiterA, reviewerA, complianceA, ownerB (key still works afterwards) | ownerA: `builds every principal…` |
| createCandidateApiKey | Outsiders (seeker), seekerALocked, seekerUnenrolled | seekerA: `builds every principal…` |
| rotateCandidateApiKey, revokeCandidateApiKey | Outsiders (seeker), seekerB | `recruvault.spec.ts` (revoke), `api-keys.test.ts` |
| upsertWalletItem | Outsiders (seeker), seekerALocked, seekerUnenrolled | seekerA: `builds every principal…` |
| deleteWalletItem, deleteWalletDocument | Outsiders (seeker), seekerB, seekerUnenrolled | `recruvault.spec.ts`; shredding in `erasure-retention.test.ts` |
| uploadWalletDocument | Outsiders (seeker), seekerALocked, seekerUnenrolled | seekerA, seekerB: `builds every principal…` |
| revokeWalletShare | Outsiders (seeker), seekerB, seekerUnenrolled | Not exercised in the browser: no share fixture. Ownership query is the same as deleteWalletItem |
| toggleSavedRole, upsertDiscoveryProfile, updateJobAlertSubscription | Outsiders (seeker), seekerALocked, seekerUnenrolled | `recruvault.spec.ts` |
| withdrawApplication | Outsiders (seeker), seekerB (another seeker's application), seekerUnenrolled | seekerA: `only the applicant can withdraw their application` |
| requestErasure | Outsiders (seeker) | `recruvault.spec.ts`, `erasure-retention.test.ts` |
| enrollVault | anonymous, forgedCookie, seekerA and ownerA (already enrolled), adminA (not owner), ownerAExpired | seekerA, seekerB: `builds every principal…` |
| unlockVault | anonymous, forgedCookie, ownerALocked with B's real key, seekerALocked with seekerB's real key, seekerUnenrolled, orglessOrg | Every member: `builds every principal…` |
| rotateVault, cancelVaultRotationAction | anonymous, forgedCookie, adminA, reviewerA, ownerAExpired, orglessOrg (reason checked) | `vault-enforcement.test.ts`, `vault-rotation.test.ts` |
| migrateLegacyRecords | anonymous, forgedCookie, adminA, ownerALocked, orglessOrg, seekerUnenrolled (reason checked) | `vault-rotation.test.ts` (migration itself) |
| completePlatformSetup | anonymous, ownerA, orglessOrg and seekerA with the real bootstrap token after setup | Platform bootstrap in `recruvault.spec.ts` / `builds every principal…` on a fresh database; races in `bootstrap.test.ts` |
| requestOtp, verifyOtp | Any caller with an unknown token; revoked, expired, consumed, and exhausted links in `secure links…` | Applicant and forwarded recipient: `builds every principal…`, `secure links…` |
| submitResponse, saveDraft | anonymous, forgedCookie, ownerA, seekerB without a link session; forged link-session cookie; consumed link | seekerA: `builds every principal…` |
| loadDraftValues | anonymous, forgedCookie, ownerA, seekerB, another link's session: empty result | Own draft: `tenant-scoped-controls.test.ts` |

## REST and file routes

| Target | Allowed | Denied, with status | Test |
| --- | --- | --- | --- |
| `/api/v1/requests` GET, POST; `/requests/:id` GET, PATCH; `/:id/jd` POST; `/:id/nda` POST; `/:id/send` POST; `/:id/submissions` GET; `/submissions/:id` PATCH; `/reports/recruiter` GET; `/match` POST | The org key with that route's scope, the all-scope org key; an unlocked owner session (read routes) | Every other single-scope org key and every seeker key (401/403); expired, revoked, unknown, unprefixed, `Basic`, and empty keys (401); revoked key with a live session cookie (401); anonymous, forged, expired, signed-out sessions (401); unverified, orgless, locked, seeker, unenrolled, reviewer sessions (403) | `REST v1: each scoped key…`, `REST v1: unusable keys…` |
| `/api/v1/me/profile` GET, PATCH; `/me/documents` GET; `/me/applications` GET | The seeker key with that scope, the all-scope seeker key; an unlocked seeker session | Every org key and other-scope seeker keys; the same unusable keys and sessions | Same |
| `/api/v1/me/key` | Any valid key; body has no key material | Revoked key (401) | `REST v1: unusable keys…` |
| Organisation A's ids with B's key | — | Read, status change, list submissions, application status change, JD and NDA upload, send (404); list and report omit A; role, documents, deliveries, and application unchanged | `REST v1: organisation B's key…` |
| Another recruiter's role with recruiterA's key or session | recruiterA's own role: read, status change, submissions (200) | Read, status change, JD and NDA upload, send (404); submissions and application status change (403/404); list omits the role; session reads (403/404); role, documents, deliveries, and application unchanged | `REST v1: a recruiter's key and session…` |
| `/api/documents/:id/view` (submission evidence) | ownerA, adminA, complianceA (download returns the bytes); reviewerA while shared (view only) | ownerALocked (409); anonymous, forged, expired, signed-out, ownerB, seekerB, orgless, unverified (403); recruiterA on a role it did not create (403); reviewer after `unshareSubmission` and reviewer download (403); unknown id (404); a verified link session for another applicant (403) | `submission documents and exports…`, `secure links…` |
| `/api/documents/:id/view` (JD) | A verified, live link session for that role | No link session, forged link-session signature (403) | `secure links…` |
| `/api/requests/:id/export` | ownerA, adminA, complianceA (contains the decrypted field) | anonymous, forged, expired, reviewer, recruiter not owning the role, seeker, unverified (403); ownerB (404); locked owner (any 4xx/5xx, no plaintext) | `submission documents and exports…` |
| `/api/wallet/documents/:id/view` | The owning seeker, unlocked | Locked owner (409); seekerB, unenrolled seeker, evidence id (404); anonymous, forged, expired, signed-out, org users (403) | `career documents stay with their owner…` |
| `/r/:token` link flow | Invited recipient with the emailed code | Forwarded holder guessing, replayed code, code after five failures, revoked, expired, unknown, and consumed links, respond page without a link session | `secure links…` |
| `/api/webhooks/resend` | A fresh svix signature (suppression written) | Unsigned, wrong secret, stale, future, malformed (401, no suppression) | `Resend webhook…` |
| `/api/inngest` (production mode) | A fresh signature with the signing key | Unsigned, malformed, wrong key, signature for another body, expired (replayed) | `test/integration/inngest-signature.test.ts` |
| `/api/auth/*` | — | Account type cannot be chosen by the client; recruiter sign-up closed; session lifecycle | `bootstrap.test.ts`, `vault-enforcement.test.ts`, `recruvault.spec.ts` |

## Onboarding without a customer key

`onboarding cannot create a workspace or vault data without a customer key` proves that a verified organisation account cannot create an organisation without an acknowledged, matching, strong key, that a job seeker who never enrolled cannot store a credential, upload a document, or mint an API key, and that completed setup stays closed even with the real bootstrap token. The Server Action matrix adds the locked and unenrolled rows for every wallet, profile, alert, and key action. `vault-enforcement.test.ts` covers locked and unenrolled organisations on every unlocked-only action.

## Leakage

- `no plaintext, customer key, API key, or link token reaches object storage or the database` reads every object in the bucket and every row of every public table after the run and searches for the per-run document markers, field marker, customer keys, API keys, and raw link tokens.
- `document-envelope.test.ts`, `request-jd-upload.test.ts`, and `erasure-retention.test.ts` cover ciphertext-only storage, shredding, and outage cleanup.
- Telemetry: `test/unit` covers `sanitizeForTelemetry` and log redaction. The browser suite does not capture server logs (see gaps).

## Fixes found by this matrix

- **Platform backups were tenant-reachable.** `updateBackupSettings` and `runBackupNow` accepted the owner of any organisation. A backup is a dump of every tenant and the first save returns the backup key, so a second tenant's owner could redirect archives to their own R2 bucket and open them. Now only the owner of the organisation that completed platform setup can configure, run, or see backups. Regression: `tenant-scoped-controls.test.ts` and the backup rows above.
- **`loadDraftValues` trusted its argument.** It is exported from a `"use server"` module, so it is a public action taking any access token id. It now returns only the verified link session's own draft. Legacy LOCAL_KEK drafts previously decrypted for any caller who knew the id. Regression: `tenant-scoped-controls.test.ts`.

## Known gaps and manual checks

Observed, not changed (product decision needed):

- A file that passes the `%PDF` sniff but is not a parseable PDF returns 500 on a watermarked (view-only) render. It fails closed with no bytes served; it is a robustness issue, not a disclosure.
- svix webhook replays inside the five-minute window are accepted. The only effect (suppression insert, delivery marked bounced) is idempotent, so there is no message-id store.

Not covered by automated tests:

- Real Resend domain verification (`verifyDomain`) and R2 uploads (`runBackupNow` success): both need external accounts. The authorisation gates are covered; the integrations are a manual release check.
- Server log content in the browser run: Playwright pipes the dev server's output to the runner, so the test cannot assert on it. Redaction is unit-tested (`telemetry-redaction.test.ts`, `security-controls.test.ts`). Release check: review new `log.*` call sites for request bodies, keys, and tokens.
- The development server's request log prints full URLs, including single-use email-verification tokens for the synthetic accounts. They expire, belong to a disposable database, and are not uploaded as artifacts, but the CI log is not secret-free in that narrow sense. Next.js only logs requests like this in development.
- Expired teammate invitations are not in the browser matrix; `test/integration/invitations.test.ts` covers expired, revoked, unknown, wrong-address, unverified, and career-record cases in-process.
- Passkey and magic-link sign-in paths are only covered for vault unlock state (`vault-enforcement.test.ts`), not in the browser matrix.
- Production-mode headers, cookies, CSP, and scanner/test-mailbox restrictions are in `scripts/smoke-production.mjs` (production-smoke job), not this matrix.
- Concurrency and fault injection (bootstrap races, interrupted rotation, storage outage, duplicate events) are integration-only: `bootstrap.test.ts`, `vault-rotation.test.ts`, `erasure-retention.test.ts`, `outbox.test.ts`.

## Running it

```sh
# PostgreSQL and MinIO running locally; DATABASE_URL must be local.
E2E_SKIP_SERVICES=1 npx playwright test e2e/security-matrix.spec.ts --trace off
# Other Inngest dev servers on 8288/8289? Move this one:
E2E_INNGEST_PORT=8299 E2E_BASE_URL=http://localhost:3120 npx playwright test
```

On one macOS checkout, a project-local `.next-e2e` made the development server rebuild on its own manifest writes and reload pages in a loop, failing the UI journeys at their first navigation. Placing `.next-e2e` outside the project (a symlink, with a `node_modules` symlink beside it) stopped it. CI's Linux runner was not observed to do this.
