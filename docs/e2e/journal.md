# Journal encryption

The journal is end-to-end encrypted with the account key (see `device-transfer.md`). The server stores ciphertext and can read nothing inside an entry.

## What the server stores

`journal_entries`: `id`, `user_id`, `household_id`, `created_at`, `updated_at`, `deleted_at`, plus
- `ciphertext` (MEDIUMTEXT, base64): the sealed entry body.
- `sealed_key` (TEXT, base64): the per-entry key, sealed to the author's account public key.
- `format` (TINYINT, currently `1`): the encryption format version.

`journal_media`: `id`, `entry_id`, `blob_key` (encrypted photo), `thumbnail_key` (encrypted thumbnail), `file_size_bytes`.

`journal_uploads`: `key`, `user_id`, `size_bytes`, `created_at`, `attached_at`. One row per uploaded blob; it counts toward the user's quota and tells the daily cleanup which uploads no entry ever claimed.

The `content`, `mood` and `tags` columns and `journal_media.media_type` are gone. The server sees the entry id, the author, the household and the dates, and nothing else.

## What the phone computes

The phone picks the entry id (a v4 uuid, sent in `POST`; a taken id is refused with 409) and encrypts the text, mood, tags, word count and anything else it wants to show, into `ciphertext`, and seals the entry key into `sealed_key`. The entry id is authenticated data (`rootaroo-journal-v1:<entryId>` for the body, `rootaroo-journal-media-v1:<entryId>` for photos), so ciphertext copied onto another entry fails to open. The inner `v` field is checked on decrypt. It decrypts on read. It also derives everything text-based: word counts, mood charts, tag lists, search, and the "On this day" snippets.

## Format version

`format` is `1`. The API rejects any other value so a future format cannot be written by mistake; bump it in `validation.ts` when a new one ships, and keep reading old ones on the phone.

## Media flow

1. The phone encrypts the photo and a thumbnail separately.
2. `POST /api/v1/journal/media/upload` (multipart, field `files`, up to 5 files per request, each `application/octet-stream`, 10 MB max; the phone sends larger sets in several requests). Each user may keep 2 GB of journal blobs in total; going over returns 413 before anything is stored. Files are stored under `journal/blobs/<userId>/` with no type check, resizing or thumbnailing. The response is `[{ fileName, size }]`; `fileName` is the storage key.
3. The phone saves the entry with `media: [{ blobKey, thumbnailKey?, sizeBytes }]`. Keys must be the caller's own uploads (`assertOwnUploadKey` with area `journal/blobs`), otherwise 403. Saving marks the uploads as attached; a daily job (`journal-upload-cleanup`) deletes the object and row of any upload still unattached after 24 hours.
4. Responses carry `media: [{ id, url, thumbnailUrl, sizeBytes }]` with short-lived signed links. The phone downloads the blobs and decrypts them.
5. On update the full attachment list is sent: existing items as `{ id }`, new ones as descriptors. Dropped items and deleted entries have their blobs removed from storage (best effort; a failure is logged and never blocks the request). Deleting an entry is a hard delete: the row, its media rows and its blobs are removed, not soft-deleted.

## Limits

- `ciphertext`: at most 96 KB decoded. `sealedKey`: at most 256 bytes decoded. Both standard base64.
- At most 10 attachments per entry; each blob at most 10 MB; at most 2 GB of blobs per user.
- Request bodies are strict: unknown fields such as `content`, `mood` or `tags` are rejected with 400.

## Endpoints

`POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `GET /stats`, `GET /history?month=YYYY-MM`, `GET /on-this-day?date=YYYY-MM-DD`, `POST /media/upload`, all under `/api/v1/journal`.

- `stats` returns `{ streak, bestStreak, wroteToday, entriesThisMonth, last7Days: [{ date, wrote }], prompt }`, computed from `created_at` only in the caller's timezone (`X-Timezone`).
- `history` returns `{ month, entryDates, daysInMonth, firstWeekday }`.
- `on-this-day` returns the encrypted entries from the same month and day in the previous five years; the phone decrypts them and builds the snippets.

## What is lost

- Server-side search over entry text, and any server-computed word counts, mood summaries, mood trends and top tags. These now live on the phone only.
- Recovery without the account key: if every phone and the backup are gone, the entries cannot be read.

## Migration

`20261015-journal-ciphertext.js` deletes all existing journal rows (pre-launch test data, decision D1) and reshapes the tables. The deletes only run while a table still has its old columns, so re-running the migration never removes encrypted rows. `down()` restores the old columns, empty. Old objects under `journal/images/` and `journal/thumbnails/` in storage are not touched by the migration and must be cleared by hand.

## Secrets on the phone

The account key pair and decrypted photos are cached in memory only, for one user at a time. The cache is dropped on sign-out, when the private space key is forgotten (including a revoked phone), when the journal lock locks, and 60 seconds after the app goes to the background (a timer, not just a check on the next foreground). A user switch never reuses the previous user's key. Screens pass only the entry id in navigation params and load the decrypted entry from the repo. Photos picked from the library or camera are plain copies in the app cache; they are deleted after a successful save, when removed from the draft, and when the editor closes.

`20261016-journal-uploads.js` creates `journal_uploads`. Blobs uploaded before it exist are not listed there, so they count toward neither the quota nor the cleanup.
