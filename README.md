# Recruvault

**Recruiter + vault.** A free, open-source secure exchange for cleared and government-adjacent hiring. Recruiters ask for what they need (clearance level, ID, expiry, right to work); job seekers provide it through a secure, expiring, audited channel — and keep those details in a personal wallet to reuse across roles. Nothing sensitive travels as an email attachment.

This is a passion project: public, MIT-licensed, and self-hostable by anyone. Issues and pull requests are welcome.

## Features

- **Organisations, users, and RBAC** — Owner / Admin / Recruiter / Reviewer / Compliance roles, enforced in the data layer (tenant + ownership checks on every read), never just the UI (`src/lib/rbac.ts`, `src/lib/guards.ts`).
- **Job seeker accounts and wallet** — email + password, magic link, and passkey sign-in (BetterAuth). Reusable credentials and documents, field-level encrypted, with a consent ledger and per-share revocation. Wallet data is self-declared and never presented as verified.
- **Favourite / saved roles** — seekers see roles sent to them, roles they responded to, and roles listed by orgs they've engaged with. Never a public job board.
- **Secure requests** — JD attachment (encrypted, virus-scanned, watermarked in-browser view), field library seeded with current AGSVA clearance levels (configurable — the PV → TS-PA transition is live), delivery + expiry settings, consent gate.
- **Delivery** — opaque single-purpose expiring links by email (Resend) and SMS (AWS SNS), sent through Inngest with retries. Recruiters see sent / opened / started / submitted without seeing data before submission.
- **Job seeker flow** — mobile-first: OTP step-up (defends forwarded links), versioned consent with IP + timestamp, watermarked JD view, wallet pre-fill, controlled uploads (type/size limits, content sniffing, ClamAV before visibility).
- **Review and export** — in-browser rendering through authorised audited routes (no public URLs), submission statuses, CSV/JSON export of decrypted structured data as a logged, role-gated action.
- **Security core** — envelope encryption (per-record DEKs wrapped by AWS KMS in ap-southeast-2, local KEK for dev), field-level encryption for PII, private S3 (or MinIO) with SSE-KMS.
- **Audit trail** — append-only, hash-chained per organisation, tamper-evident (integrity is verified on the audit page). No PII in the log; survives purges as a metadata-only record.
- **Retention and deletion** — per-org retention windows enforced by a scheduled purge; deletion is a crypto-shred (destroy the DEK, then remove rows and objects); full job-seeker erasure honouring APP 11.2.

## Stack

Next.js (App Router) · TypeScript · Tailwind · BetterAuth · PostgreSQL + Drizzle · Inngest · Resend · AWS S3/KMS/SNS (or MinIO) · ClamAV · Docker Compose.

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

Without `RESEND_API_KEY`, emails (secure links, OTP codes) are logged to the dev console instead of sent. `SCAN_DISABLED=true` skips ClamAV in dev only.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed/refresh reference data (idempotent) |
| `npm run typecheck` | TypeScript check |

## Self-hosting

`docker compose up` builds the app and runs PostgreSQL, ClamAV, and MinIO (S3-compatible), so a deployment can be fully self-contained — no AWS account required. If you prefer AWS, point the S3/KMS env vars at real services (ap-southeast-2 keeps data resident in Australia).

## Security posture

- Handling classification: **OFFICIAL: Sensitive at most** — candidate-declared clearance information and identity documents for screening, never classified material.
- AU data residency by default (ap-southeast-2 for data and keys) when using AWS.
- Recruvault does **not** verify identity documents; it stores and presents them for recruiter review. Verification would be a future integration.
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

[MIT](LICENSE) — free to use, modify, and self-host. Job seeker data belongs to job seekers; this project exists to keep passports and clearance details out of email inboxes.
