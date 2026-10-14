# Data map

Every place Recruvault keeps data, what it holds, and what happens to it on a retention purge and on job-seeker account deletion. Use it to check a post-erasure inventory.

**Purge** means an organisation retention purge or a recruiter deleting one submission (`purgeSubmission`). **Account deletion** means a job seeker deleting their account (`eraseCandidate`). Both write an `erasure_records` row and queue storage objects on `deletion_tasks`.

## Identity and access

| Table | Holds | Purge | Account deletion |
| --- | --- | --- | --- |
| `user` | Name, email, account type | — | Kept as a tombstone: name and email replaced, image cleared, `erased_at` set. The id can never get a session again. |
| `session`, `vault_unlocks` | Sign-in sessions, session-bound key unlocks | — | Deleted first |
| `account` | Password hash, OAuth tokens | — | Deleted first |
| `passkey` | Passkey public keys | — | Deleted first |
| `verification` | Pending magic-link, reset, and verification tokens | — | Rows naming the email or user id deleted first |
| `candidate_api_keys` | Key hash, prefix, wrapped vault key | — | Revoked and wrap cleared first, then deleted with the account |
| `rate_limit`, `link_rate_limits` | Counters keyed by IP or path | — | Not linked to the account; expire with their window |

Registering again with the same email creates a new, empty account. Nothing from the deleted account is restored.

## Career record (job seeker)

| Table / object | Holds | Account deletion |
| --- | --- | --- |
| `candidate_accounts` | Account link, phone | Deleted |
| `wallet_items` | Credential ciphertext | Data keys shredded, rows deleted |
| `wallet_documents` + `wallet/<account>/<uuid>` objects | Career document metadata (file name, type) and ciphertext object | Data keys shredded, rows deleted, objects queued for deletion |
| `wallet_shares` | Consent ledger: which item or document went to which organisation | Deleted |
| `saved_roles`, `job_alert_subscriptions`, `job_match_notifications` | Saved roles, alert preferences, alert ledger | Deleted |
| `discovery_profiles` | Opt-in plaintext matching facts | Deleted |
| `vault_keys` (candidate) | Public key, wrapped private key, verifier | Private key wrap cleared, status `shredded` |

Deleting one wallet document shreds its key, queues its object, and deletes the row in one transaction.

## Applications (organisation records)

| Table / object | Holds | Purge | Account deletion |
| --- | --- | --- | --- |
| `submissions` | Status, times, responder email | Row kept with `purged_at`; responder email cleared | Every submission linked to the account is purged |
| `submission_values` | Field ciphertext | Data keys shredded, rows deleted | Same |
| `submission_documents`, `documents` (evidence) + `org/<org>/<uuid>` objects | Evidence metadata and ciphertext object | Data keys shredded, rows deleted, objects queued | Same |
| `consents` | Notice version, time, IP | IP cleared; version and time kept as consent evidence | Same |
| `access_tokens`, `deliveries` | Link recipient email and phone, delivery status | Recipient replaced with `redacted`, phone and OTP hash cleared | Same, for linked submissions |
| `submission_shares` | Which reviewer can see a submission | Kept (ids only) | Same |

Responses sent through a secure link without signing in are organisation records. They follow the organisation's retention policy and are not reached by a job seeker's account deletion.

Recruiter JDs and NDAs (`documents` with kind `jd`/`nda`) belong to the organisation. Replacing a JD through the API shreds the old document's key and queues its object in the same transaction.

### Retention policy

- Default: a submission is purged `retention_days` after it was submitted.
- Purge on close: purged `retention_days` after the role closed, or after the role's expiry when it has no close time. Any submission is also capped at `retention_days` + 365 days, so a role that never closes cannot keep data forever.
- Abandoned drafts: a never-submitted draft is purged once its link has expired or been revoked, or its role is closed or archived.

## Keys and cleanup state

| Table | Holds | Notes |
| --- | --- | --- |
| `data_keys` | Wrapped DEKs, optional LOCAL_KEK render wrap | Shredding clears every wrap, including the render wrap, and sets `shredded_at`. The row stays so ciphertext references fail closed. |
| `deletion_tasks` | Storage key, attempts, state, linked erasure | Kept until the object is gone; `done` rows are pruned after 90 days by the reconciler |
| `erasure_records` | Subject type and id, progress timestamps, object count | Metadata only. Distinguishes access revoked, keys shredded, cleanup pending, and cleanup finished. |
| `document_migrations` | Legacy migration progress | Ids and storage keys only |

## Kept after deletion

| Item | Why |
| --- | --- |
| `audit_events` | Hash-chained, metadata-only trail (ids, action, time). On purge and account deletion the IP and user agent of that actor's events are cleared; they are outside the hash, so the chain still verifies. |
| `user` tombstone | Prevents the id from signing in again |
| `suppressions` | Bounced or complained addresses, so mail is not sent to them again |
| `outbox_events` | Event payloads hold ids only |
| `sms_events` | Last three digits of a number only |

## Storage versions, multipart uploads, and backups

- Shredding destroys every wrap of a document's data key in the same transaction that queues the object. From that commit the ciphertext cannot be opened from the live system, even while object deletion is still retrying.
- On a versioned bucket a plain delete leaves earlier versions. Set `S3_DELETE_ALL_VERSIONS=true` so deletion removes every version and delete marker of the key. Without it, old versions remain as ciphertext whose keys are shredded.
- Uploads are single `PutObject` calls of at most 15 MB; there are no multipart uploads to abort.
- Bucket replication copies ciphertext. Replica deletion follows the bucket's replication rules, which Recruvault does not control.
- Database and object backups (including R2 archives) taken before deletion still hold the wrapped data keys and ciphertext. Anyone who restores such a backup and holds the matching customer key or `LOCAL_KEK` can read it until the backup expires. Shredding a key in the live database does not reach into earlier backups. See [operations](operations.md#restore).
