import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

/** Largest sealed entry the server accepts: text plus the small metadata the phone packs in. */
export const MAX_CIPHERTEXT_BYTES = 96 * 1024;
export const MAX_SEALED_KEY_BYTES = 256;
/** Largest encrypted photo or thumbnail (also the upload limit). */
export const MAX_BLOB_BYTES = 15 * 1024 * 1024;

/** Standard base64 whose decoded size is at most `maxBytes`. */
const base64Schema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64')
    .refine((s) => s.length % 4 === 0, 'must be base64')
    .refine((s) => Buffer.from(s, 'base64').length <= maxBytes, `must be at most ${maxBytes} bytes`);

// Keys only: the phone uploads the encrypted photo and thumbnail first, then
// names them here. Ownership of the keys is checked in the service.
const newMediaSchema = z
  .object({
    blobKey: z.string().min(1, 'blobKey is required').max(500),
    thumbnailKey: z.string().min(1).max(500).optional(),
    sizeBytes: z.number().int().positive().max(MAX_BLOB_BYTES),
  })
  .strict();

const mediaSchema = z.array(newMediaSchema).max(10, 'Maximum 10 media items per entry');

/**
 * On update the client sends the complete attachment list. An existing
 * attachment is referenced by `{ id }` and a newly uploaded one by its full
 * descriptor; anything not listed is dropped.
 */
const updateMediaSchema = z
  .array(z.union([z.object({ id: z.string().uuid() }).strict(), newMediaSchema]))
  .max(10, 'Maximum 10 media items per entry');

const encryptedFields = {
  ciphertext: base64Schema(MAX_CIPHERTEXT_BYTES),
  sealedKey: base64Schema(MAX_SEALED_KEY_BYTES),
  format: z.literal(1),
};

export const createEntrySchema: ValidationSchemas = {
  body: z.object({ ...encryptedFields, media: mediaSchema.optional() }).strict(),
};

export const updateEntrySchema: ValidationSchemas = {
  body: z.object({ ...encryptedFields, media: updateMediaSchema.optional() }).strict(),
  params: z.object({ id: z.string().uuid() }),
};

export const entryIdParamSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
};

export const entryQuerySchema: ValidationSchemas = {
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
};

export const historyQuerySchema: ValidationSchemas = {
  query: z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'month must be formatted YYYY-MM')
      .optional(),
  }),
};

export const onThisDayQuerySchema: ValidationSchemas = {
  query: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be formatted YYYY-MM-DD')
      .optional(),
  }),
};
