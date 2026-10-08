# Account key, device transfer and backup (W10)

Status: design approved by owner 2026-10-08. Build waves: W10 (this), then W11 journal encryption and W12 shared vault, which use the account key described here.

## Goals

- The journal and vault are readable only on the user's own phone. Rootaroo's servers hold ciphertext, public keys and routing data, never anything that opens it.
- One phone at a time holds the key. Moving to a new phone moves the key and signs the old phone out.
- A lost phone can be recovered with a backup password (a pet's name is fine) or a recovery code, without Rootaroo being able to open the backup.

Non-goals for W10: several devices at once, request signing with a device key (T12), the rest of the app (chat, feed, …) which stays server-readable until the post-MVP MLS work.

## What the user sees

1. **First use of the journal or vault.** "Set up your private space": pick a backup password (6+ characters, a pet's name is fine) or "Use a recovery code instead" (the app shows a code to save). A third option, "No backup", is allowed after a clear warning that losing the phone loses the data.
2. **New phone, old phone still works.** The new phone shows a QR code. The user opens Rootaroo on the old phone, taps "Move to a new phone", scans, checks that both phones show the same 6-digit code, approves with Face ID or fingerprint. The private data moves; the old phone is signed out and forgets the key.
3. **Phone lost.** On the new phone: "Restore with your backup password" → enter the email code Rootaroo sends → enter the password. "7 tries left" is shown after a wrong guess. After 10 wrong guesses the backup is erased for good. Success signs out the lost phone.
4. **Signed in on a second phone without moving.** Everything except the journal and vault works. Those show "Your private space is on another phone" with buttons to move it here or restore from backup.

Rootaroo cannot read the journal or vault, reset the backup password, or recover data after the backup is erased. Setup says so in one sentence.

## Keys

| Key | Kind | Where it lives | Used for |
|---|---|---|---|
| Account key pair `(ak_sk, ak_pk)` | X25519 | `ak_sk` only on the key-holding phone (SecureStore, biometric); `ak_pk` on the server (`account_keys`) | Receiving sealed item keys: own journal entries and vault files (W11, W12), household vault files from other adults (W12) |
| Item key | AES-256-GCM, random per item | Never stored in the clear; sealed to one or more `ak_pk` | Encrypting one journal entry, photo or vault file |
| Transfer ephemeral keys | X25519, per transfer | Memory only | One QR transfer |
| Backup keys `auth_key`, `enc_key` | 32 bytes each, from Argon2id(password) | Memory only | Proving the password to the server; decrypting the backup |

**Sealing** (one primitive everywhere, no custom protocol): to seal bytes `m` to `pk`, generate an ephemeral X25519 pair `(e_sk, e_pk)`, `shared = X25519(e_sk, pk)`, `k = HKDF-SHA256(shared, salt = e_pk ‖ pk, info = "rootaroo-seal-v1")`, `c = AES-256-GCM(k, nonce = random 12 bytes, m)`. The sealed value is `e_pk ‖ nonce ‖ c`. Opening reverses it with `ak_sk`. This is the ECIES pattern; all primitives come from `react-native-quick-crypto` WebCrypto (X25519, HKDF, AES-GCM).

## Transfer to a new phone (QR)

1. **New phone N** (signed in, no key): generates `(eN_sk, eN_pk)` and a random 16-byte `qr_secret`. `POST /api/v1/key-transfer/sessions { ephemeralPublicKey: eN_pk }` → `{ sessionId, expiresAt }` (5 minutes). N shows a QR with `{ v: 1, sessionId, eN_pk, qr_secret }`. **`qr_secret` never goes to the server.**
2. **Old phone O** (holds the key, same user): scans the QR, `GET /key-transfer/sessions/:id` and checks the server's `ephemeralPublicKey` equals the QR's `eN_pk` (abort otherwise). Generates `(eO_sk, eO_pk)`, `shared = X25519(eO_sk, eN_pk)`, `k = HKDF(shared, salt = qr_secret, info = "rootaroo-transfer-v1" ‖ sessionId)`. Shows a 6-digit code `= HKDF(shared, salt = qr_secret, info = "rootaroo-transfer-sas-v1")` mod 10^6; N shows the same code once it has `eO_pk`.
3. User confirms the codes match and approves on O (biometric). O sends `POST /key-transfer/sessions/:id/payload { ephemeralPublicKey: eO_pk, sealed: AES-256-GCM(k, nonce, ak_sk ‖ ak_pk, aad = sessionId) }`.
4. N receives it (socket `key-transfer:payload` to N's user room, with polling fallback), derives `k`, decrypts, checks `ak_pk` equals the server's `account_keys.public_key`, stores `ak_sk`, and calls `POST /key-transfer/sessions/:id/complete`.
5. Server, in one transaction: marks N as the key holder, revokes O (W9 revoke: sessions, push token), marks the session done. O's next request gets `401 DEVICE_REVOKED`; the app then deletes its local key and data caches.

The server sees two ephemeral public keys and ciphertext. Without `qr_secret`, which only travels through the camera, it cannot derive `k`, and substituting its own ephemeral key is caught in step 2. Sessions are single-use, expire after 5 minutes, and only the session's user can read or complete it. At most one open session per user.

## Backup and recovery

**Setup** (on the key-holding phone):
1. User picks a password (min 6 characters) or the app generates a recovery code (24 characters from a 32-letter alphabet, about 120 bits, shown in groups of 4).
2. `salt` = 16 random bytes. `stretched = Argon2id(secret, salt, m = 19 MiB, t = 2, p = 1, 64 bytes)` (OWASP minimum; parameters stored with the backup so they can be raised later). `auth_key = HKDF(stretched, info = "rootaroo-backup-auth-v1")`, `enc_key = HKDF(stretched, info = "rootaroo-backup-enc-v1")`.
3. `blob = AES-256-GCM(enc_key, ak_sk ‖ ak_pk)`.
4. `PUT /api/v1/key-backup { kind: 'password' | 'recovery_code', salt, kdf, authKey: auth_key, blob }` over TLS.
5. Server: `verifier = KeyVault.mac(auth_key)` and `stored_blob = KeyVault.encrypt(blob)`, both done by the key vault service (below); stores `{ verifier, stored_blob, salt, kdf, kind, attempts_left = 10 }`. `auth_key` itself is never stored or logged.

**Restore** (new phone, signed in):
1. `POST /key-backup/restore/start` → Rootaroo emails a 6-digit code (10 minutes, 5 tries, rate-limited per user and IP).
2. `POST /key-backup/restore/params { emailCode }` → `{ salt, kdf, kind, attemptsLeft, restoreToken }` (token valid 10 minutes).
3. Phone derives `auth_key`, `enc_key`. `POST /key-backup/restore { restoreToken, authKey }`.
4. Server: `KeyVault.verifyMac(auth_key, verifier)`. Wrong → `attempts_left - 1`; at 0 the backup row is deleted, the user is emailed, and the response says it is gone. Right → `attempts_left` resets to 10, response is `KeyVault.decrypt(stored_blob)`, and the same completion as a transfer runs (this phone becomes key holder, previous key holder revoked).
5. Phone decrypts `blob` with `enc_key`, checks `ak_pk` matches the server, stores `ak_sk`.

**Why a short password is safe here.** Guessing requires the server: the blob in the database is encrypted again with a key held in the key vault service, and the verifier is a MAC keyed there too, so a copy of the database alone allows no offline guessing. Online guessing is capped at 10 per backup, behind an email code. This mirrors WhatsApp's encrypted backups (HSM-held key, limited attempts), with a managed key service in place of WhatsApp's own HSM fleet. Residual risk, stated plainly: someone who controls the running server and the key vault service could guess a weak password offline. A recovery code removes that risk.

**Changing or removing the backup** needs the key on the phone and biometric approval; it replaces the row (new salt, attempts reset). "No backup" deletes it.

## Key vault service

A new service category in the W4 adapter layer (`server/src/services`):

| Provider | Use | Env |
|---|---|---|
| `aws-kms` | Production. HMAC key (`GenerateMac`/`VerifyMac`) for verifiers, symmetric key (`Encrypt`/`Decrypt`, encryption context = user id) for blobs. Both keys are non-exportable and HSM-backed. | `KEY_VAULT_PROVIDER=aws-kms`, `KEY_VAULT_REGION`, `KEY_VAULT_MAC_KEY_ID`, `KEY_VAULT_ENC_KEY_ID` |
| `local` | Development and tests, and production while there is no paid key service: HMAC/AES with keys derived from `KEY_VAULT_LOCAL_SECRET`. | `KEY_VAULT_PROVIDER=local`, `KEY_VAULT_LOCAL_SECRET` |

Test and live use separate KMS keys, following the billing key separation rule.

### Free now, KMS later

Production may run `KEY_VAULT_PROVIDER=local` (no cost) when `KEY_VAULT_LOCAL_SECRET` is at least 64 characters and is a different value from `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `CALENDAR_TOKEN_KEK`; the server refuses to start otherwise, and logs a warning that backups are protected by a server secret. This is weaker than KMS: whoever gets both the database and that secret can guess backup passwords offline (a recovery code is immune). Keep the secret out of the repository and out of database backups.

Every backup row records the provider that protected it (`key_backups.vault_provider`, default `local`, migration `20261017`). Restore opens a row with the provider recorded on it, so switching providers loses nothing:

1. Set `KEY_VAULT_PROVIDER=aws-kms` and the KMS variables. Keep `KEY_VAULT_LOCAL_SECRET` set: while it is, `local` stays available as a legacy provider.
2. A backup made before the switch still restores. The restore response carries `rewrap: true`, and the phone silently saves the backup again with the password or recovery code the user just typed, so the row is now protected by KMS.
3. When every active backup has been re-protected, `KEY_VAULT_LOCAL_SECRET` can be removed. A row that needs a provider that is not configured answers 503 `KEY_VAULT_UNAVAILABLE` ("Backups are temporarily unavailable") and costs no attempt.

Email restore codes and restore tokens are short-lived MACs made with the current provider: codes issued before a switch simply become invalid and the user asks for a new one.

## Server data

| Table | Columns | Notes |
|---|---|---|
| `account_keys` | `user_id` PK, `public_key` (base64 raw X25519), `key_version`, timestamps | One per user. Replaces `vault_keys`. |
| `devices` (W9) | add `holds_account_key` boolean | Exactly one true per user at most. |
| `key_transfer_sessions` | `id`, `user_id`, `new_device_id`, `new_ephemeral_public_key`, `old_ephemeral_public_key`, `payload`, `status` (open, sent, done, expired), `expires_at`, timestamps | Rows deleted 1 day after expiry by a job. |
| `key_backups` | `user_id` PK, `kind`, `salt`, `kdf` JSON, `verifier`, `stored_blob`, `attempts_left`, timestamps | |
| `key_restore_codes` | `user_id`, `code_hash`, `expires_at`, `attempts_left` | Email codes and restore tokens, stored as key vault MACs (not plain hashes). |

All new models set `paranoid: false`. Pre-launch vault data (`vault_documents`, `vault_document_keys`, `vault_keys`, `vault/` objects) is reset (D1); W12 rebuilds the vault on the account key.

## API summary

All under `/api/v1`, authenticated, not behind the paywall (a lapsed household must still be able to move or restore its data, and data export T1 depends on it).

| Method and path | Who |
|---|---|
| `GET /account-key` | Own public key and whether this device holds it |
| `PUT /account-key` | First-time creation only (409 if one exists) |
| `POST /key-transfer/sessions`, `GET /key-transfer/sessions/:id`, `POST …/:id/payload`, `POST …/:id/complete` | Same user; payload only from the current key holder; complete only from the session's new device |
| `GET /key-backup` | Kind, created date, attempts left (no secrets) |
| `PUT /key-backup`, `DELETE /key-backup` | Current key holder only |
| `POST /key-backup/restore/start`, `/restore/params`, `/restore` | Signed-in user on a device that does not hold the key |

## Mobile

- `shared/crypto/accountKey.js`: create, store and load `ak_sk` (SecureStore with `requireAuthentication`), `seal(pk, bytes)`, `open(sealed)`.
- `shared/crypto/keyTransfer.js`, `shared/crypto/keyBackup.js`: the two flows above, with injectable crypto and API for tests.
- Screens: Set up private space; Move to a new phone (scanner, `expo-camera`); This phone (QR display); Restore from backup (email code, password, tries left); Settings → Privacy & security gains Backup (change, recovery code, remove) and shows "This phone holds your private space".
- On `401 DEVICE_REVOKED` the app deletes `ak_sk` and the decrypted-data caches before signing out.
- Old vault RSA code (`vaultCrypto.js` RSA paths, `vaultSetup.js`, `keyPinStore.js` TOFU for own key, iOS-only `Alert.prompt` recovery) is removed; the vault switches to `seal`/`open` with the account key (personal files only until W12).

## Tests

- Mobile unit: seal/open round trip and tamper rejection; transfer derivation on two simulated phones (same code, same key; wrong `qr_secret` fails; substituted server key aborts); backup derive/encrypt/decrypt; wrong password; Argon2id parameters recorded.
- Server unit and MySQL integration: session lifecycle and authorisation (other user, wrong device, expired, reused), single key holder, revoke of the old device, backup attempts counting down to deletion, email code limits, production accepts the local key vault only with a strong, distinct secret, the provider recorded on each backup row and used on restore (legacy provider missing is a 503 that spends no try, rewrap flag), `aws-kms` provider against a mocked KMS client.
- Device checklist: transfer iOS→Android and back, restore after reinstall, 10 wrong guesses, old phone wiped after transfer.

## Review

External cryptography review before any public "end-to-end encrypted" claim (T13). Until then the app says "Your journal and vault are encrypted on your phone".

## Known limits

- **A phone that lost the key can still sign in.** Moving or restoring signs the old phone out, but signing in again on it is allowed: everything except the journal and vault works. Signing in never makes it the key holder again (`upsertDevice` does not touch `holds_account_key`), and on sign-in or session restore the app asks the server and deletes a stale local key.
- **A modified app can keep its copy.** The server removes the old holder's access, but it cannot reach into a phone. A tampered app that ignores the server could have kept a copy of the account key it once held, and so could open ciphertext it still has or later fetches. Rotating the account key on every move and re-sealing items is post-MVP (tracker T19).
- **Revoke when Redis is down.** The revoke is written to the database first. If the Redis marker cannot be written, requests fall back to checking the database whenever Redis errors. If Redis recovers without the marker, an already-issued access token (15 minutes at most) keeps working until it expires; the refresh path always checks the database.
- **Removing the key holder** clears the holder: no phone holds the key until one restores from the backup. Moving is then refused with `NO_KEY_HOLDER`.
