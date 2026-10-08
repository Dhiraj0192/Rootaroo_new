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

export const summaryQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    from: z.coerce.date().default(() => new Date(Date.now() - 30 * 86400_000)),
    to: z.coerce.date().default(() => new Date()),
  }),
};

export const subscriptionsQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused']).optional(),
    cursor: cursorSchema,
    limit: limitSchema,
  }),
};

export const runsQuerySchema: ValidationSchemas = { query: z.object({ mode: modeSchema, cursor: cursorSchema, limit: limitSchema }) };
export const itemsQuerySchema: ValidationSchemas = {
  query: z.object({ mode: modeSchema, status: z.enum(['auto_fixed', 'needs_review', 'resolved', 'ignored']).optional(), cursor: cursorSchema, limit: limitSchema }),
};
export const runBodySchema: ValidationSchemas = { body: z.object({ mode: z.enum(['test', 'live']) }) };
export const resolveSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ resolution: z.enum(['resolved', 'ignored']), note: z.string().min(1).max(1000) }),
};
export const replayParamsSchema: ValidationSchemas = { params: z.object({ id: z.string().min(1).max(255) }) };

export const cohortSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ cohort: z.enum(['live', 'test']), reason: z.string().min(3).max(500), force: z.boolean().optional().default(false) }),
};

export const routingSchema: ValidationSchemas = {
  body: z.object({
    rules: z.array(z.object({
      platform: z.enum(['ios', 'android', 'web']),
      country: z.string().regex(/^(\*|[A-Z]{2})$/),
      method: z.enum(['stripe_checkout', 'apple_iap', 'google_play', 'none']),
    })).min(1).max(500),
  }),
};
