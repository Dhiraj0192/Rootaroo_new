# Shared vault

Vault files are end-to-end encrypted. The server stores ciphertext and can read neither a file nor its name. Each file is either Personal or Household. Keys are the account keys described in `device-transfer.md`.

## What the server stores

`vault_documents`: `id`, `household_id`, `uploaded_by`, `created_at`, `updated_at`, plus
- `sealed_meta` (TEXT, base64, at most 2 KB): the file name and type, sealed on the phone.
- `scope` (`personal` | `household`, default `personal`).
- `size_bytes`: kept in the clear for the 2 GB per-uploader quota.
- `s3_key`: the encrypted file, stored as `application/octet-stream` under `vault/<uploaderId>/`.

`vault_document_keys`: one row per `(document_id, user_id)` with `wrapped_key` (base64, at most 256 bytes), the file key sealed on a phone to that person's account public key. Rows cascade when the document is deleted. No row means no access.

The `name`, `mime_type`, `encrypted_key` and `iv` columns and the `vault_keys` table (the old per-household RSA keys) are gone. Migration `20261016-shared-vault.js` deletes all existing vault rows (D1, pre-launch test data) and drops them; S3 objects under `vault/` have to be cleared by hand.

## Roles

- Personal: only the uploader sees it, with exactly one key (the uploader's).
- Household: sealed to every adult (admin or member, never child) who has an account key. A child cannot be sealed to (400) and never sees household files (404).
- Only the uploader renames a file or switches it between Personal and Household. Switching to Personal deletes every key except the uploader's. Switching to Household adds the keys sent with the request.
- The uploader or a household admin can delete a file (storage object and rows). An admin can delete any file of the household, including a Personal one, but cannot see or open a Personal file; other members get 404 for it.
- Children can upload Personal files only.

## Upload

`POST /api/v1/vault`, multipart: `file` (ciphertext, at most 20 MB) and `meta`, a JSON string `{ scope, sealedMeta, sizeBytes, keys: [{ userId, sealedKey }] }`. The uploader's own key is required. Personal: `keys` is exactly the uploader. Household: every key's user must be a current adult member with an account key (else 400). Adults left out are allowed; they see the file as pending.

## Pending files and grants

An adult who joined later, or who has no account key yet when a file is uploaded, has no key row. `GET /vault` returns that file with `mySealedKey: null`, `pending: true` and no `downloadUrl`.

Another adult's phone resolves it:
1. `GET /vault/pending-grants` lists household files the caller can open where a current adult with an account key still lacks one: `[{ documentId, mySealedKey, missing: [{ userId, publicKey }] }]`.
2. The phone opens `mySealedKey`, seals the file key to each missing public key.
3. `POST /vault/:id/keys { grants: [{ userId, sealedKey }] }`. The caller must hold a key (403), the file must be household, each target a current adult with an account key (400) and without a key yet (409).

`GET /vault/members` lists adults of the household with an account key and their public keys, for sealing at upload time.

## Leaving, removal, becoming a child

`onMemberLostVaultAccess(userId, householdId)` in `server/src/modules/vault/access.ts` deletes the person's keys for that household's household files. It runs when a member is removed, leaves, is made a child, and for every member when a household is purged. Personal files are not touched.

## Known limits

- Someone who already opened a file keeps whatever they saved on their phone; deleting a key cannot take a copy back.
- The file key itself is not rotated when someone loses access. Re-encrypting household files on leave is T14.
- If the only holder of a file's key leaves or becomes a child, the remaining adults see it as pending with nobody able to grant it.
- Size, upload date, uploader and Personal/Household scope are visible to the server.
