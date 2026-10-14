# Operations

## Fresh install

1. Generate `BETTER_AUTH_SECRET`, `LOCAL_KEK`, and `BOOTSTRAP_TOKEN` with `openssl rand -hex 32`. Use different values. Do not reuse the development defaults.
2. For production, also set `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, an `https://` `APP_URL`, and `TRUSTED_DOMAINS`. Leave `INNGEST_DEV` empty. Set `ALLOW_RECRUITER_SIGNUP=false`. With Compose, also set `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (and a matching `DATABASE_URL`), `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, and a separate `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` for the app's bucket-scoped MinIO user.
3. Start with `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`. The production file does not publish PostgreSQL or MinIO, and it refuses missing secrets. The `migrate` service applies migrations and seeds reference data before the app starts; either failure stops the app from starting.
4. `npm run check:deploy-env` checks the process environment and does not print secret values. The app refuses to boot in production with placeholder or reused secrets, a default database or storage password, `SCAN_DISABLED`, `PLAYWRIGHT_TEST`, `INNGEST_DEV`, missing email credentials, or a non-https `APP_URL`. `/api/live` is liveness. `/api/health` is readiness: it returns 503 when the database or object store is unreachable and reports `degraded` while ClamAV is not answering (uploads are refused until it does).
5. Complete [first-owner bootstrap](#first-owner-bootstrap): open `/setup`, create the owner account, open the verification email, then submit the organisation name, `BOOTSTRAP_TOKEN`, and a new encryption key. Store the encryption key outside the server. Setup stores only a verifier and wrapped key material.

Development binds published ports to `127.0.0.1` and can include the Inngest dev server. Production compose does not start that server.

## First-owner bootstrap

- **Provision.** Generate `BOOTSTRAP_TOKEN` with `openssl rand -hex 32` and set it only in the deployment's secret store (Compose `.env` outside the repo, or a Railway variable). Hand it to the intended owner over a channel that is not email to the owner address. Leave `ALLOW_RECRUITER_SIGNUP=false`; setup works without it.
- **Use.** The owner opens `/setup`, creates the account, follows the verification link (it returns to `/setup`, and the flow survives a refresh or browser restart), then enters the token with the organisation name and encryption key. The token travels only in the request body. Wrong tokens are rate limited per client and deployment-wide and are audited as `platform.setup_rejected` without the value.
- **Retire.** Once setup succeeds, the bootstrap row is consumed and every instance redirects `/setup` to sign-in, even after restarts. From then on the token is inert and a replay is refused. The production boot check still expects a value, so replace `BOOTSTRAP_TOKEN` with a fresh random value that nobody holds, redeploy, and destroy the copy given to the owner.
- **Recover.** If an install was interrupted after an organisation row existed but before an owner did, set a fresh `BOOTSTRAP_RECOVERY_TOKEN`, have the owner sign in at `/setup`, and submit that token with the organisation's existing encryption key. Recovery cannot claim a completed install and cannot enrol a new key over an existing vault. Remove the recovery token afterwards. If an owner account exists but email delivery failed, fix email delivery and use **Resend verification email** on `/setup`; never mark the address verified in the database.

Installs that already had an owner before the bootstrap row existed are marked complete automatically on first request.

## Deployment hardening

- **Ingress.** Production compose publishes only the app, on `127.0.0.1:3000`. Terminate TLS in a reverse proxy on the same host (Caddy, nginx, or a load balancer) and forward to that port. Do not publish PostgreSQL, MinIO, ClamAV, or the MinIO console. Recruvault sets HSTS, so serve the site only over https.
- **Forwarded headers.** Set `TRUSTED_PROXY_HOPS` to the number of proxies that append to `X-Forwarded-For` (default 1). Rate limits read the client address that many hops from the right, so a client cannot choose its own address by sending the header. Proxies must set `X-Forwarded-Proto`.
- **Object storage.** The bucket is private (`mc anonymous set none`) and the app's MinIO user can only get, put, delete, and list objects in that bucket. On AWS S3, block public access and grant the app the same four actions on the bucket only. Document bytes are encrypted before upload; storage-side encryption is defence in depth.
- **Runtime container.** The app runs as an unprivileged user with a read-only root filesystem, a tmpfs for `/tmp` and the Next.js cache, all Linux capabilities dropped, and `no-new-privileges`. The image has no npm, Yarn, or Corepack. A `HEALTHCHECK` probes `/api/live`.
- **Images.** Base images and Compose services are pinned by version and digest and updated through Dependabot. CI scans the `runner`, `migrate`, and Railway images with Trivy and fails if any layer contains an `.env` file. The upstream `minio/minio` images are no longer published on Docker Hub, so Compose uses the `pgsty/minio` community rebuild; point `S3_ENDPOINT` at AWS S3 or another S3-compatible store to avoid it.
- **Jobs.** Production needs signed Inngest (Cloud or self-hosted with `INNGEST_SIGNING_KEY`). Delivery, the outbox publisher, document cleanup, retention purge, and nightly backups all run there. If jobs stop, `/api/health` still passes, so monitor Inngest run failures and the outbox depth.
- **Railway.** The pre-deploy command migrates and seeds inside the final image. Set the same production variables there, including `BOOTSTRAP_TOKEN`, Inngest keys, Resend credentials, and `CLAMAV_HOST`/`CLAMAV_PORT` for a ClamAV service on the private network. The Railway image keeps the migration tooling and `src` for that command; it contains no deployment secrets.

## Upgrade

Apply migrations before starting the new app. The migrate container uses the same lockfile and fails if migration fails. `test/integration/schema-upgrade.test.ts` creates a database at the last pre-vault release (migration 0009), writes `LOCAL_KEK` records the way that release did, applies every later migration, and reads them back. Customer envelopes remain readable across the upgrade because rotation rewraps data keys instead of rewriting document bytes. Legacy rows stay on `LOCAL_KEK` until the legacy field migration (run when an owner unlocks) or the document migration rewraps them.

Plaintext document objects from before document envelopes are encrypted in place by the `migrate-legacy-documents` job (see [encryption](encryption.md#legacy-plaintext-migration)). Until a document migrates it is served from its original object. Watch the job's count-only log line; `remaining` reaches zero once every owner with legacy files has enrolled a key. `failed` migrations keep their original and need an operator to check the stored checksum before clearing the `document_migrations` row.

Take a database backup and keep `LOCAL_KEK` plus any customer keys in a separate place from that backup before upgrading.

## Backups, access domains, and restore

| Secret or data | Holder | Kept with |
| --- | --- | --- |
| Database and object ciphertext | R2 `.rvbak` archives | R2 bucket, retained `retainCount` nights (default 14) |
| Backup key (shown once) | Operator | A password manager or vault, not on the app host and not in R2 |
| `LOCAL_KEK`, `BETTER_AUTH_SECRET` | Operator | The deployment secret store, with its own access list |
| Customer keys | Each organisation owner and job seeker | Outside Recruvault. Never in backups |
| R2 credentials | Operator | Deployment secret store; scoped to the backup bucket |

Keep these in separate access domains: nobody should get the archive, the backup key, and `LOCAL_KEK` from one place. The database also holds the backup key wrapped by `LOCAL_KEK` so the nightly job can run, so whoever holds `LOCAL_KEK` and a database copy can open archives; protect `LOCAL_KEK` accordingly. Review who holds each item quarterly and when staff change.

- **RPO**: 24 hours (one successful nightly archive). Use your database provider's point-in-time recovery if you need less.
- **RTO**: target 4 hours to an isolated, verified restore. Practise it at least quarterly.

### Restore procedure

1. Create an empty PostgreSQL database in an isolated environment. Never restore over production.
2. Download the `.rvbak` archive. Put the backup key in a file readable only by you (`chmod 600`).
3. Run, from a checkout of the same release:

   ```bash
   RESTORE_DATABASE_URL=postgres://…/recruvault_restore \
   BACKUP_KEY_FILE=/secure/backup.key \
   npm run backup:restore -- ./archive.rvbak --objects-dir ./restored-objects
   ```

   The script migrates the target, refuses a non-empty database (`--truncate` only for a throwaway target), refuses the live `DATABASE_URL`, restores rows in foreign-key order, and prints table, row, and object counts only. It never prints the key or row contents. Objects are written owner-only to the directory; upload them to an isolated bucket for a full trial.
4. Point an isolated app instance at the restored database and bucket with the same `LOCAL_KEK`. Owners unlock with their customer keys (or the key that was active when the archive was taken, if they have rotated since). Check that a sample of records opens.
5. Records whose keys were shredded before the archive stay unreadable: the restore copies the null wrap. An archive taken before a deletion can still open the deleted record; do not restore it over a deployment that has already promised deletion, and keep `retainCount` within your deletion policy.
6. Record the date, archive id, counts, duration, and pass/fail. Do not record keys or contents. Delete the isolated environment and the key file when done.

`test/integration/restore.test.ts` exercises this path end to end against a fresh database.

## Key rotation

Rotation is done by an organisation owner or a job seeker from **Rotate encryption key** (`/vault/rotate`). See [encryption](encryption.md#rotation) for how it works.

**Dry run.** Restore the latest archive into an isolated environment (above), unlock there, and rotate. Confirm it completes and a sample of records opens with the new key. This also proves the old key, the new key, and the backup are all usable.

**Run.**

1. Sign in again (rotation needs a sign-in from the last 15 minutes) and unlock.
2. Generate the new key, save it, and confirm you can read it back. Keep the old key.
3. Submit the current and new key. Large workspaces may return before finishing; the page then shows rewrapped and remaining counts. Submit the same pair again to resume.
4. When it completes, every other session and integration key is locked out. Issue new API keys and ask other members to unlock with the new key.

**Completion report.** Counts and versions only:

```sql
select owner_type, from_version, to_version, state, rotated_count, created_at, completed_at
from vault_rotations where owner_id = '<owner uuid>' order by created_at desc limit 1;
select key_version, count(*) from data_keys
where owner_id = '<owner uuid>' and shredded_at is null group by key_version;
```

The second query must show only the new version (plus version 0 for any remaining legacy keys). Audit events `vault.rotation_*` record who and when.

**Rollback criteria.** Before completion, cancel if the new key was not saved, if errors repeat, or if the counts stop moving. Cancel needs only the current key and moves every record back. After completion there is no rollback; keep the old key until every archive taken before the switch has aged out of retention, then destroy it.

**Retired keys.** At the switch the old version's wrapped private key is deleted from the live database once the locked recount shows no record left on it. The version row stays as history. Older archives keep their own copy and still need the old customer key.

**Secret handling.** Enter keys only into the masked fields. Never paste them into tickets, chat, shell history, logs, or screenshots. The app never logs or audits key material.

### Suspected key compromise

1. Rotate immediately. This stops the old key from opening anything written or rewrapped afterwards.
2. Revoke and re-issue API keys, and sign out other sessions.
3. Treat everything the old key could open as disclosed. Rotation cannot revoke plaintext or data keys an attacker already copied, and archives taken before the rotation still open with the old key; shorten their retention or delete them if the policy allows.
4. If `LOCAL_KEK` may be exposed, legacy rows and render-delegated documents are exposed too. Do not change `LOCAL_KEK` in place; that makes legacy rows unreadable. Migrate legacy records under customer keys first.

## Rollback

If a migration has not been applied, redeploy the previous image. If it has been applied, restore the isolated backup from step 1 rather than running the new code against a partially migrated database. Do not change `LOCAL_KEK` to try to read old rows.

## Deletion and erasure

Deleting a job-seeker account is full account deletion, not only the career record. [data-map.md](data-map.md) lists every table and object and what happens to it.

1. One transaction revokes access: API keys, sessions and their vault unlocks, password and OAuth credentials, passkeys, and pending verification tokens. The `user` row becomes a tombstone with no name or email, and a session hook refuses any new session for it.
2. One transaction shreds every data key (wallet, documents, submissions, vault private key), queues each storage object on `deletion_tasks`, and deletes the career record and the linked submissions' PII.
3. The deletion queue removes the objects. The `erasure_records` row moves from access revoked to keys shredded and cleanup pending, then to cleanup finished when every linked task is done.

Retention purges follow steps 2 and 3 for one submission. A process that dies between steps leaves either nothing changed or a durable record: `resume-erasures` (every 5 minutes) finishes stopped account deletions, and `retry-deletions` (every minute) works the queue.

The queue claims tasks with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, retries with backoff up to 8 attempts, then marks the task `dead` and logs an error with the task id. An object S3 reports as missing counts as deleted; a missing bucket does not. After fixing the cause, requeue dead tasks with `retryDeadDeletionTasks()` from `src/lib/deletion-queue.ts`; repeating it is safe.

`reconcile-storage` runs hourly. It queues objects under `org/` and `wallet/` that no row, in-flight migration, or open task references and that are older than 24 hours, reports pending, stuck (3+ attempts or older than a day), and dead tasks, finishes erasure records whose cleanup is done, and prunes completed tasks after 90 days. Its log line holds counts only and is logged at error level when anything is stuck or dead.

On a versioned bucket set `S3_DELETE_ALL_VERSIONS=true` so deletion removes every version. Backups keep deleted ciphertext and wrapped keys until they expire; see [Restore](#restore).

## Nightly backups

An organisation owner configures Cloudflare R2 from Organisation settings. The server encrypts the database dump and document objects with a 256-bit backup key, then uploads one `.rvbak` object. R2 stores ciphertext only. The raw backup key is shown once and is not the workspace encryption key. A wrapped copy stays in the database so the hourly job can run after the chosen UTC hour if that day's backup has not succeeded. Workspace encryption keys are not in the archive. Restoring a backup does not recover a lost workspace key, and it can resurrect ciphertext from before a deletion.

Losing the workspace encryption key is permanent for the records it protects. Losing only the displayed backup key does not stop nightly backups while `LOCAL_KEK` and the database remain. Losing both the backup key and `LOCAL_KEK` makes every existing R2 archive unreadable.

To inspect an archive without printing row contents, save the backup key outside the server and decrypt it with the key in an isolated environment. Do not restore it over a deployment that has already deleted records unless that restore is intentional.

## Logging and telemetry

Production without an email provider fails the send and does not log the code or link. Without `SMS_ENABLED=true` an SMS is recorded as skipped and its delivery marked failed; the message body (which holds the secure link) is never printed. `PLAYWRIGHT_TEST=1` and `SCAN_DISABLED=true` are refused in production, and the mailbox and scan bypass also check `NODE_ENV` themselves. The development mailbox under `.playwright/outbox` contains credentials, is owner-only (`0600`), git-ignored, and ephemeral; delete it after a run and never copy it into screenshots or support bundles.

Every log line passes through `src/lib/logger.ts`: the message string, an error passed as the first argument, and nested objects (including `cause` chains) are redacted before the line is written. Redaction removes authorization and cookie headers, passwords, OTPs, raw API keys, customer and deployment keys, provider credentials, bearer and basic credentials, credentials in connection strings, values after `params:` in database errors, `/r/<token>` and reset/verify/magic-link path segments, URL query strings on URL fields, email addresses, and phone numbers. Error codes, ids, counts, route shapes, and timings remain. Sentry (server runtime only; the browser and edge proxy do not report) drops request bodies, cookies, headers, query strings, user contact fields, and stack-frame variables, and applies the same redaction (`src/lib/telemetry.ts`). The browser console prints action errors only in development.

Operational logs are separate from the compliance audit trail. Neither holds field plaintext, ciphertext, or key material. Treat operational logs as confidential: restrict read access to operators, keep them no longer than 30 days unless an incident needs them, and do not attach raw log exports to tickets. Audit rows follow the retention in [data-map.md](data-map.md).

## Background events (outbox)

Every Inngest event is written to `outbox_events` in the same transaction as the change that needs it, then published after commit by the request (best effort) and by the `publish-outbox` cron every minute. Payloads hold ids only: no addresses, phone numbers, links, or keys. Publishers claim rows with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, so concurrent publishers never send the same row. The event id is the outbox dedupe key, so a re-send after a crash is dropped by Inngest. Failed publishes back off from 30 seconds to an hourly cap; after 30 attempts (about a day) the row is `dead`.

Consumers are idempotent. Request delivery sends each invitation and SMS once per delivery row, rebuilding the link from the access-token id and `LINK_SESSION_SECRET` inside the job so the link is never stored. Recruiter submission alerts, scans (document scan state), job-match alerts (`job_match_notifications`), and expiry reminders (`reminder_sent_at`) each have their own once-only marker. The consumer ledger (`consumed:*` rows in `outbox_events`) is never published. Retrying a send from the dashboard or API within two minutes returns the already-queued delivery.

The `outbox-maintenance` cron (every 15 minutes) re-creates events for committed work without one (unscanned plaintext documents, submissions from the last 7 days without a received event), prunes published rows after 7 days and dead and ledger rows after 30, prunes idle rate-limit windows, and logs `metric: "outbox_depth"` with `pending`, `due`, `dead`, and `oldestPendingSeconds`. It logs a warning when anything is dead or the oldest pending row is over 15 minutes old. Alert on that warning.

Operator commands print metadata only (ids, event names, state, attempts, times, and the redacted last error), never payloads or dedupe keys:

```bash
npm run outbox -- stats
npm run outbox -- list dead        # or pending, published
npm run outbox -- retry <id> ...   # requeue specific dead rows with a fresh attempt budget
npm run outbox -- retry-dead       # requeue every dead row
npm run outbox -- reconcile
npm run outbox -- prune
```

Compensation and retry paths:

| Failure | What happens |
| --- | --- |
| Object upload fails | Nothing is committed; the user retries. |
| Upload succeeds, DB transaction fails | The link submit path deletes the uploaded objects and shreds their data keys. An object left without a row holds only ciphertext, and the storage reconciler queues orphaned objects for deletion. |
| Commit succeeds, inline publish fails or the process dies | The row stays `pending`; the cron publishes it. Reconciliation re-creates rows for older committed work without one. |
| Publish keeps failing | Backoff, then `dead`. Fix Inngest, then `retry-dead`. |
| Consumer fails | Inngest retries the step. Failure handlers mark deliveries failed and scans errored, so owners see "failed", never a false "sent". |
| Event delivered twice | The consumer's once-only marker makes the second run a no-op. |

Pending documents stay inaccessible until a clean scan; a lost event leaves them pending (never visible) until reconciliation re-queues the scan.

Upgrade note: rows queued by the previous release (`request/send` carrying an address, `email/event`) still drain. Old `request/send` rows are converted into a delivery row whose id-only event performs the send. Before rolling back to a release older than this one, run `npm run outbox -- stats` and wait for `pending` to reach 0, because older code cannot read id-only `request/send` events.

## API keys and request budgets

Keys carry explicit scopes and an expiry of at most 365 days. Reporting keys (`reports:read`, `roles:read`) cannot create roles, upload JDs, send invitations, list submissions, or change a profile. Creating or rotating a key needs the account password or a sign-in from the last 15 minutes, and an unlocked vault. Each user may hold 10 active keys and an organisation 50; the cap is enforced in one locked transaction. Removing a member revokes their keys in the same transaction, and keys of removed members, erased accounts, or a changed role stop working at once because every request re-checks live membership and role.

Keys created before scoped keys (`legacy:full`) are not upgraded or rotated. They are rejected with a "must be replaced" error; create a new scoped key and revoke the old one.

Budgets are PostgreSQL windows shared by every instance: per key across routes, per user, per organisation, per IP and route, and tighter per-route limits for JD uploads, invitations, submission exports, and matching. A 429 carries `Retry-After` with the seconds left in the exhausted window. The IP comes from `X-Forwarded-For`, counting `TRUSTED_PROXY_HOPS` entries from the end (default 1, the proxy described above). Set it to the number of proxies you run; `0` ignores the header.
