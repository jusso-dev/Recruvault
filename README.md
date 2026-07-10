# Recruvault

**Recruiter + vault.** A free, open-source hiring workspace for cleared and government-adjacent recruitment. Recruiters manage roles and move candidates from application through review, shortlist, interview, offer, and placement. Job seekers track applications and keep reusable resumes, cover letters, and clearance details in one secure career record. Identity documents, right-to-work evidence, and police-check documents are never collected.

This is a passion project: public, MIT-licensed, and self-hostable by anyone. Issues and pull requests are welcome.

## Product tour

| Recruiter placement dashboard | Job seeker application dashboard |
| --- | --- |
| ![Recruiter placement dashboard with role, candidate, action, placement, and pipeline metrics](docs/screenshots/21-recruiter-dashboard.png) | ![Job seeker dashboard with applications, saved roles, career documents, and pipeline metrics](docs/screenshots/17-job-seeker-overview.png) |

<details>
<summary><strong>Public pages and account experience</strong></summary>

| Landing page | Sign in |
| --- | --- |
| ![Recruvault landing page](docs/screenshots/01-landing.png) | ![Recruvault sign-in page](docs/screenshots/02-sign-in.png) |

| Friendly dismissible error | Account creation |
| --- | --- |
| ![Friendly dismissible sign-in error toast](docs/screenshots/03-friendly-error-toast.png) | ![Job seeker and recruiter account creation](docs/screenshots/04-sign-up.png) |

</details>

<details>
<summary><strong>Workspace setup and role management</strong></summary>

| Empty recruiter dashboard | Empty job seeker dashboard |
| --- | --- |
| ![New recruiter workspace dashboard](docs/screenshots/05-recruiter-dashboard-empty.png) | ![New job seeker application dashboard](docs/screenshots/06-job-seeker-overview-empty.png) |

| Organisation and member settings | Create a role |
| --- | --- |
| ![Organisation settings and team member roles](docs/screenshots/07-organisation-settings.png) | ![Create a role with clearance, resume, and cover letter requirements](docs/screenshots/08-new-role.png) |

| Role detail and candidate invitations | Permission denied state |
| --- | --- |
| ![Recruiter role details and candidate invitation controls](docs/screenshots/09-role-detail.png) | ![Friendly permission denied screen for a reviewer](docs/screenshots/10-permission-denied.png) |

| Recruiter matched-alert controls | Job-seeker alert subscription |
| --- | --- |
| ![Recruiter controls for opt-in skill-matched role notifications](docs/screenshots/09b-recruiter-matched-alerts.png) | ![Job seeker applications, roles, and matching alert preferences](docs/screenshots/13-applications-and-roles.png) |

</details>

<details>
<summary><strong>Job seeker workflow</strong></summary>

| Career documents | Profile and credentials |
| --- | --- |
| ![Reusable resumes and cover letters](docs/screenshots/11-career-documents.png) | ![Job seeker discovery profile and clearance credentials](docs/screenshots/12-profile-and-credentials.png) |

| Applications and saved roles | Secure invitation |
| --- | --- |
| ![Application tracker and saved roles](docs/screenshots/13-applications-and-roles.png) | ![Secure recruiter invitation and OTP step-up](docs/screenshots/14-secure-invitation.png) |

| Application form | Submission confirmation |
| --- | --- |
| ![Application form requesting only clearance, resume, and suitability statement](docs/screenshots/15-application-form.png) | ![Secure application submission confirmation](docs/screenshots/16-application-submitted.png) |

| Application tracker after submission |
| --- |
| ![Job seeker application stage tracker](docs/screenshots/18-applications-tracker.png) |

</details>

<details>
<summary><strong>Recruiter and reviewer workflow</strong></summary>

| Candidate review | Placed candidate |
| --- | --- |
| ![Recruiter reviewing structured clearance values and documents](docs/screenshots/19-candidate-review.png) | ![Candidate progressed to placed and shared with a reviewer](docs/screenshots/20-placed-candidate.png) |

| Audit trail | Reviewer read-only access |
| --- | --- |
| ![Tamper-evident organisation audit trail](docs/screenshots/22-audit-trail.png) | ![Reviewer read-only candidate access](docs/screenshots/23-reviewer-read-only.png) |

</details>

<details>
<summary><strong>Responsive dashboards</strong></summary>

| Mobile recruiter dashboard | Mobile job seeker dashboard |
| --- | --- |
| ![Responsive recruiter placement dashboard](docs/screenshots/24-mobile-recruiter-dashboard.png) | ![Responsive job seeker application dashboard](docs/screenshots/25-mobile-job-seeker-overview.png) |

</details>

<details>
<summary><strong>API and MCP access</strong></summary>

| Job seeker integrations | Recruiter integrations |
| --- | --- |
| ![Job seeker API keys, REST endpoints, and MCP setup](docs/screenshots/26-job-seeker-api-mcp.png) | ![Recruiter API keys, REST endpoints, and MCP setup](docs/screenshots/27-recruiter-api-mcp.png) |

| Codex using Recruvault MCP | Profile updated through MCP |
| --- | --- |
| ![Codex using Recruvault MCP to update a job seeker's skills from their GitHub profile](docs/screenshots/28-codex-recruvault-mcp-profile-update.png) | ![Job seeker discovery profile showing skills updated through Recruvault MCP](docs/screenshots/29-job-seeker-profile-updated-via-mcp.png) |

| Application follow-up planning | Profile and career-document review |
| --- | --- |
| ![Recruvault MCP reviewing five job applications and producing a concise weekly follow-up plan](docs/screenshots/30-mcp-application-follow-up-plan.png) | ![Recruvault MCP reviewing a job seeker's discovery profile and career-document readiness](docs/screenshots/31-mcp-profile-document-review.png) |

</details>

## Features

- **Organisations, users, and RBAC** — Owner / Admin / Recruiter / Reviewer / Compliance roles, enforced in the data layer (tenant + ownership checks on every read), never just the UI (`src/lib/rbac.ts`, `src/lib/guards.ts`).
- **Job seeker application workspace** — track drafts and submitted applications through shortlist, interview, offer, and placement. Save relevant roles and see the current stage without searching through email.
- **Career documents and credentials** — keep current resumes, cover letters, and reusable clearance details together, with field-level encryption, a consent ledger, and per-share revocation. Identity documents, right-to-work evidence, and police-check documents are intentionally excluded.
- **Recruiter placement pipeline** — manage active roles and move each candidate through review, shortlist, interview, offer, and placement with a clear action queue and audited status history.
- **Dual-consent matched role alerts** — recruiters opt in at organisation level and choose a minimum skill-match threshold; job seekers independently subscribe with skills, locations, employment types, work arrangements, and salary/rate preferences. Only open, listed roles generate deduplicated emails, and matching never exposes job-seeker identity, profile data, or documents to recruiters.
- **Favourite / saved roles** — seekers see roles sent to them, roles they responded to, and roles listed by orgs they've engaged with. Never a public job board.
- **REST API and MCP** — role-aware developer access for recruiters and job seekers, including copyable setup and reporting prompts. The recruiter report covers outstanding information, previous-month applications, unfilled roles, stage aging, stalled candidates, application velocity, deadlines, weekly priorities, and matched-alert performance. Job-seeker keys remain limited to their owner-scoped applications, career-document metadata, and safe discovery profile.
- **Secure requests** — JD attachment (encrypted, virus-scanned, and served with a per-view watermark burned into the PDF), field library seeded with current AGSVA clearance levels (configurable — the PV → TS-PA transition is live), delivery + expiry settings, consent gate.
- **Delivery** — opaque single-purpose expiring links by email (Resend) and SMS (AWS SNS), sent through Inngest with retries. Recruiters see sent / opened / started / submitted without seeing data before submission.
- **Job seeker flow** — mobile-first: OTP step-up (defends forwarded links), versioned consent with IP + timestamp, watermarked JD view (viewer identity + timestamp burned into every page for traceability), wallet pre-fill, controlled uploads (type/size limits, content sniffing, ClamAV before visibility).
- **Review and export** — in-browser rendering through authorised audited routes (no public URLs), submission statuses, CSV/JSON export of decrypted structured data as a logged, role-gated action.
- **Security core** — envelope encryption (per-record DEKs wrapped by a self-managed master key, no external KMS), field-level encryption for PII, and private S3-compatible object storage. AWS S3 uses SSE-S3 (AES-256); MinIO can opt in when its KMS is configured.
- **Audit trail** — append-only, hash-chained per organisation, tamper-evident (integrity is verified on the audit page). No PII in the log; survives purges as a metadata-only record.
- **Retention and deletion** — per-org retention windows enforced by a scheduled purge; deletion is a crypto-shred (destroy the DEK, then remove rows and objects); full job-seeker erasure honouring APP 11.2.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind · BetterAuth · PostgreSQL + Drizzle · Inngest · Resend · AWS S3/SNS (or MinIO) · ClamAV · Docker Compose.

Interactive API documentation is available at `/api/v1/docs`, with the OpenAPI 3.1 document at `/api/v1/openapi.json`. Signed-in users can create scoped keys, copy MCP configuration, or copy a ready-to-use coding-agent setup prompt from **API & MCP** in their workspace navigation.

## Local development

```bash
cp .env.example .env.local   # fill in BETTER_AUTH_SECRET and LOCAL_KEK (openssl rand -hex 32)
echo "INNGEST_DEV=1" >> .env.local

docker compose up db clamav minio -d   # or point DATABASE_URL at your own Postgres

npm install
npm run db:migrate
npm run db:seed        # AGSVA clearance levels + reference vocabularies
npm run dev            # app on :3000
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest   # background jobs
```

Open `http://localhost:3000`. A fresh installation redirects to `/setup`, where the first recruiter creates the owner account and organisation. Once an organisation exists, `/setup` redirects to sign-in.

Recruiter self-registration is controlled by `ALLOW_RECRUITER_SIGNUP`. The local `.env.example` sets it to `true` so the recruiter flow can be tested. Set it to `false` in production after the first owner uses `/setup`; job seekers can continue registering from `/sign-up`. The API enforces this setting as well as the visible form.

For screenshot-ready local data, first create one recruiter and one job-seeker account through the UI, then run:

```bash
npm run db:seed-demo -- --recruiter owner@example.com --seeker seeker@example.com
```

The idempotent demo seed creates six realistic roles, 31 applications across the placement pipeline, seven outstanding invitations, skill tags, alert preferences, and matched-alert activity. It does not create users, credentials, uploaded files, identity data, police checks, or real email deliveries.

### Email delivery with Resend

Set these values in `.env.local`, then restart the development server:

```bash
RESEND_API_KEY=re_your_key
RESEND_FROM_EMAIL=onboarding@resend.dev
```

`onboarding@resend.dev` is suitable for local testing and can deliver only to the email address associated with your Resend account. To send verification links, magic links, invitations, and notifications to other recipients, verify a domain in Resend and set `RESEND_FROM_EMAIL` to an address on that domain, such as `no-reply@jobs.example.com`. Set `SHARED_SENDING_DOMAIN` to the same verified domain for organisation-branded sending. Without `RESEND_API_KEY`, emails are logged to the development console instead of sent. Configure `RESEND_WEBHOOK_SECRET` to process bounce and complaint events.

Email verification and password recovery use the same Resend configuration. Password reset links expire after one hour and revoke the account’s existing sessions after a successful reset.

`SCAN_DISABLED=true` skips ClamAV in development only.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed/refresh reference data (idempotent) |
| `npm run db:seed-demo -- --recruiter … --seeker …` | Seed screenshot-ready roles, applications, reporting, and matched-alert data for existing accounts |
| `npm run typecheck` | TypeScript check |
| `npm run test:e2e` | Run the Playwright UI suite and regenerate README screenshots |

## Self-hosting

`docker compose up` builds the app and runs PostgreSQL, ClamAV, and MinIO (S3-compatible), so a deployment can be fully self-contained — no AWS account required. On startup a one-shot `migrate` service applies the database migrations and a `minio-init` service creates the documents bucket, and the app waits for both plus a healthy ClamAV before booting — so a fresh `docker compose up` yields a working stack with no manual steps. ClamAV's first boot takes a few minutes to load signatures; the healthcheck accounts for this.

Set `BETTER_AUTH_SECRET` and `LOCAL_KEK` (both required; generate each with `openssl rand -hex 32`). `LOCAL_KEK` is the self-managed master key that wraps every data key, so keep it secret and backed up. If you prefer AWS S3 over MinIO, point the S3 env vars at real services (ap-southeast-2 keeps data resident in Australia).

## Security posture

- Handling classification: **OFFICIAL: Sensitive at most** — candidate-declared clearance information and career documents only, never classified material.
- AU data residency by default (ap-southeast-2 for data and keys) when using AWS.
- Recruvault deliberately does not collect identity documents, right-to-work evidence, or police-check documents.
- Document watermarking burns viewer identity + timestamp into every rendered page, so a leaked view-only copy is **traceable** — it is not DRM. The overlaid text is still extractable from the served bytes; true anti-extraction would need server-side page rasterisation (a native renderer), which isn't implemented. Permitted downloads serve the clean original by design.
- Confirm AGSVA clearance nomenclature periodically and update `REFERENCE_SEED` in `src/lib/fields.ts` — the framework is mid-transition (PV phasing out in favour of TS-PA).

## Layout

```
src/
  db/            schema, connection, seed
  lib/           crypto (envelope + shred), rbac, guards, audit (hash chain),
                 email, sms, storage, scan, link-session, retention, review
  actions/       server actions: org, requests, submissions, link flow, wallet
  inngest/       delivery, scanning, retention purge, reminders, email webhooks
  app/           landing, auth, /dashboard (org), /wallet + /roles (seeker),
                 /r/[token] (secure link flow), /api routes
```

## License

[MIT](LICENSE) — free to use, modify, and self-host. Job seeker data belongs to job seekers; this project exists to keep unnecessary sensitive documents out of email inboxes.
