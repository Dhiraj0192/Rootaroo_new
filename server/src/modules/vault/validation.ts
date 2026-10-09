import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

const base64 = (maxChars: number) => z.string().min(1).max(maxChars).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Must be base64');

// 2 KB and 256 bytes of raw data, as base64 characters.
const sealedMeta = base64(2732);
const sealedKey = base64(344);

const keyEntry = z.object({ userId: z.string().uuid(), sealedKey }).strict();
const scope = z.enum(['personal', 'household']);

const uploadMeta = z.object({
  scope,
  sealedMeta,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  keys: z.array(keyEntry).min(1).max(30),
}).strict();

// The file part is binary, so the rest of the upload arrives as one JSON string field.
export const createVaultDocumentSchema: ValidationSchemas = {
  body: z.object({
    meta: z.string().transform((raw, ctx) => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'meta must be valid JSON' });
        return z.NEVER;
      }
    }).pipe(uploadMeta),
  }),
};

export const documentIdParamSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
};

export const updateVaultDocumentSchema: ValidationSchemas = {
  body: z.object({ sealedMeta }).strict(),
  params: z.object({ id: z.string().uuid() }),
};

export const changeScopeSchema: ValidationSchemas = {
  body: z.object({ scope, keys: z.array(keyEntry).max(30).optional() }).strict(),
  params: z.object({ id: z.string().uuid() }),
};

export const grantKeysSchema: ValidationSchemas = {
  body: z.object({ grants: z.array(keyEntry).min(1).max(30) }).strict(),
  params: z.object({ id: z.string().uuid() }),
};

export const vaultDocumentQuerySchema: ValidationSchemas = {
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
};
