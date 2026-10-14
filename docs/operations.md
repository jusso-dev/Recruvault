# Operations

## Fresh install

1. Generate `BETTER_AUTH_SECRET`, `LOCAL_KEK`, and `BOOTSTRAP_TOKEN` with `openssl rand -hex 32`. Use different values. Do not reuse the development defaults.
2. For production, also set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Leave `INNGEST_DEV` empty. Set `ALLOW_RECRUITER_SIGNUP=false`.
3. Start with `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`. The production file does not publish PostgreSQL or MinIO, and it refuses missing secrets.
4. `npm run check:deploy-env` checks the process environment and does not print secret values. `/api/live` is liveness. `/api/health` is readiness and requires the database.
5. Open `/setup`, verify the owner email from the message Recruvault sends, then submit the bootstrap token and a new encryption key. Store the encryption key outside the server. Setup stores only a verifier and wrapped key material.

Development binds published ports to `127.0.0.1` and can include the Inngest dev server. Production compose does not start that server.

## Upgrade

Apply migrations before starting the new app. The migrate container uses the same lockfile and fails if migration fails. Customer envelopes remain readable across the upgrade because rotation rewraps data keys instead of rewriting document bytes. Legacy rows stay on `LOCAL_KEK` until an owner rotates or a migration rewraps them.

Take a database backup and keep `LOCAL_KEK` plus any customer keys in a separate place from that backup before upgrading.

## Restore

1. Restore the database and object store into an isolated environment, not over production.
2. Provide the same `LOCAL_KEK` that wrapped legacy rows and render delegation.
3. Customer keys are not in the database. Owners enter them again to unlock.
4. Records whose data keys were shredded stay unreadable. A backup from before shredding can still open those records if the key that wrapped them is supplied. Do not restore that backup over a deployment that has already promised deletion.
5. Confirm counts of active vaults, pending outbox rows, and deletion tasks. Do not print keys or ciphertext.

Rotation can be resumed by submitting the same current and new key. It finishes only after every customer data key for that owner is on the new version.

## Rollback

If a migration has not been applied, redeploy the previous image. If it has been applied, restore the isolated backup from step 1 rather than running the new code against a partially migrated database. Do not change `LOCAL_KEK` to try to read old rows.

## Nightly backups

An organisation owner configures Cloudflare R2 from Organisation settings. The server encrypts the database dump and document objects with a 256-bit backup key, then uploads one `.rvbak` object. R2 stores ciphertext only. The raw backup key is shown once and is not the workspace encryption key. A wrapped copy stays in the database so the hourly job can run after the chosen UTC hour if that day's backup has not succeeded. Workspace encryption keys are not in the archive. Restoring a backup does not recover a lost workspace key, and it can resurrect ciphertext from before a deletion.

Losing the workspace encryption key is permanent for the records it protects. Losing only the displayed backup key does not stop nightly backups while `LOCAL_KEK` and the database remain. Losing both the backup key and `LOCAL_KEK` makes every existing R2 archive unreadable.

To inspect an archive without printing row contents, save the backup key outside the server and decrypt it with the key in an isolated environment. Do not restore it over a deployment that has already deleted records unless that restore is intentional.

## Logging

Production without an email provider fails the send and does not log the code or link. `PLAYWRIGHT_TEST=1` and `SCAN_DISABLED=true` are refused in production. The development mailbox under `.playwright/outbox` contains credentials, is owner-only, and must not be copied into screenshots or support bundles.
