import { z } from 'zod';
import type { ValidationSchemas } from '../../../shared/middleware/validate';

export const modeSchema = z.enum(['test', 'live']).default('live');
export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);
export const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).optional();
export const pingSchema: ValidationSchemas = {};

export const transactionsQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    householdId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    type: z.enum(['payment', 'failed_payment', 'refund', 'dispute']).optional(),
    status: z.string().max(32).optional(),
    matchStatus: z.enum(['matched', 'unmatched']).optional(),
    billingReason: z.string().max(40).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: cursorSchema,
    limit: limitSchema,
  }),
};

export const idParamSchema: ValidationSchemas = { params: z.object({ id: z.string().uuid() }) };
