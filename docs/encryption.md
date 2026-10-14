# Encryption

Recruvault uses envelope encryption. Each field or document has its own data key. New data keys are wrapped by a customer key for that organisation or job seeker, or sealed to that owner's public key when the writer is a secure-link responder.

This is not zero-knowledge.

| Threat | Result |
| --- | --- |
| Database copy without session cookies or API keys | New envelopes stay unreadable. Legacy envelopes still open with `LOCAL_KEK`. |
| Object store copy | New document objects are ciphertext. The original filename is not in the object key. The database still stores the filename and content type as metadata. |
| Unlocked session or stolen API key | The server can decrypt that owner's records until the session ends or the key is revoked. |
| Password reset | Does not replace or reveal the customer key. The next session must enter it again. |
| Operator with `LOCAL_KEK` | Can read legacy rows and organisation documents that were explicitly render-delegated so a secure link can display them. Wallet values and wallet files do not get that delegation. |
| Lost customer key | Profiles, documents, and submissions protected by that key stay ciphertext. Password reset, support, and `LOCAL_KEK` cannot reconstruct it. There is no replacement key. |
| Lost backup key and `LOCAL_KEK` | R2 archives cannot be opened. The live workspace is unaffected. A saved backup key, or `LOCAL_KEK` plus the database, can still open them. |
| Backup taken before deletion | Can still contain ciphertext. Destroying the data key does not erase that backup. |

Sharing with a recruiter copies the submission into an envelope sealed to the organisation. Revoking a wallet share does not remove a submission that was already received.

`BOOTSTRAP_TOKEN` is the first-owner capability. It is separate from the customer key and from `BETTER_AUTH_SECRET`. Setup refuses to mark an email verified; the normal verification link has to be used. After an owner exists, setup stays closed. If an organisation row exists without an owner, `BOOTSTRAP_RECOVERY_TOKEN` is the only way to attach one.

API keys expire, carry explicit scopes, and hold a wrap of the customer key created while the vault was unlocked. `legacy:full` is only the migration scope for keys that already existed. New keys cannot use it. A reporting scope cannot create roles or send invitations.
