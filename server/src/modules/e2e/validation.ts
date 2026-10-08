import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

const isCanonicalBase64 = (s: string): boolean => Buffer.from(s, 'base64').toString('base64') === s;

/** Base64 of exactly `bytes` bytes. */
const b64Exact = (bytes: number) =>
  z.string().max(Math.ceil(bytes / 3) * 4).refine(
    (s) => isCanonicalBase64(s) && Buffer.from(s, 'base64').length === bytes,
    `must be base64 of exactly ${bytes} bytes`,
  );

/** Base64 of 1 to `maxBytes` bytes. */
const b64Max = (maxBytes: number) =>
  z.string().min(1).max(Math.ceil(maxBytes / 3) * 4).refine(
    (s) => isCanonicalBase64(s) && Buffer.from(s, 'base64').length <= maxBytes,
    `must be base64 of at most ${maxBytes} bytes`,
  );

const publicKey = b64Exact(32);
const sessionIdParams = z.object({ id: z.string().uuid() });

export const createAccountKeySchema: ValidationSchemas = {
  body: z.object({ publicKey }),
};

export const createTransferSessionSchema: ValidationSchemas = {
  body: z.object({ ephemeralPublicKey: publicKey }),
};

export const transferSessionParamSchema: ValidationSchemas = { params: sessionIdParams };

export const transferPayloadSchema: ValidationSchemas = {
  params: sessionIdParams,
  body: z.object({ ephemeralPublicKey: publicKey, sealed: b64Max(4096) }),
};

// Bounds keep a hostile or buggy client from storing parameters no phone could ever run.
const kdfSchema = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(8192).max(524288),
  iterations: z.number().int().min(1).max(10),
  parallelism: z.number().int().min(1).max(8),
  length: z.number().int().min(32).max(128),
}).strict();

export const putBackupSchema: ValidationSchemas = {
  body: z.object({
    kind: z.enum(['password', 'recovery_code']),
    salt: b64Exact(16),
    kdf: kdfSchema,
    authKey: b64Exact(32),
    blob: b64Max(4096),
  }),
};

export const restoreParamsSchema: ValidationSchemas = {
  body: z.object({ emailCode: z.string().regex(/^\d{6}$/, 'must be 6 digits') }),
};

export const restoreSchema: ValidationSchemas = {
  body: z.object({ restoreToken: z.string().min(16).max(128), authKey: b64Exact(32) }),
};
