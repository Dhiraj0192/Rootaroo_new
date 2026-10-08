# Journal encryption

The journal is end-to-end encrypted with the account key (see `device-transfer.md`). The server stores ciphertext and can read nothing inside an entry.

## What the server stores

`journal_entries`: `id`, `user_id`, `household_id`, `created_at`, `updated_at`, `deleted_at`, plus
- `ciphertext` (MEDIUMTEXT, base64): the sealed entry body.
- `sealed_key` (TEXT, base64): the per-entry key, sealed to the author's account public key.
- `format` (TINYINT, currently `1`): the encryption format version.

`journal_media`: `id`, `entry_id`, `blob_key` (encrypted photo), `thumbnail_key` (encrypted thumbnail), `file_size_bytes`.

The `content`, `mood` and `tags` columns and `journal_media.media_type` are gone. The server sees the entry id, the author, the household and the dates, and nothing else.

## What the phone computes

The phone encrypts the text, mood, tags, word count and anything else it wants to show, into `ciphertext`, and seals the entry key into `sealed_key`. It decrypts on read. It also derives everything text-based: word counts, mood charts, tag lists, search, and the "On this day" snippets.

## Format version

`format` is `1`. The API rejects any other value so a future format cannot be written by mistake; bump it in `validation.ts` when a new one ships, and keep reading old ones on the phone.

## Media flow

1. The phone encrypts the photo and a thumbnail separately.
2. `POST /api/v1/journal/media/upload` (multipart, field `files`, up to 10 files, each `application/octet-stream`, 15 MB max). Files are stored under `journal/blobs/<userId>/` with no type check, resizing or thumbnailing. The response is `[{ fileName, size }]`; `fileName` is the storage key.
3. The phone saves the entry with `media: [{ blobKey, thumbnailKey?, sizeBytes }]`. Keys must be the caller's own uploads (`assertOwnUploadKey` with area `journal/blobs`), otherwise 403.
4. Responses carry `media: [{ id, url, thumbnailUrl, sizeBytes }]` with short-lived signed links. The phone downloads the blobs and decrypts them.
5. On update the full attachment list is sent: existing items as `{ id }`, new ones as descriptors. Dropped items and deleted entries have their blobs removed from storage (best effort; a failure is logged and never blocks the request).

## Limits

- `ciphertext`: at most 96 KB decoded. `sealedKey`: at most 256 bytes decoded. Both standard base64.
- At most 10 attachments per entry; each blob at most 15 MB.
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

`20261015-journal-ciphertext.js` deletes all existing journal rows (pre-launch test data, decision D1) and reshapes the tables. `down()` restores the old columns, empty. Old objects under `journal/images/` and `journal/thumbnails/` in storage are not touched by the migration and must be cleared by hand.
