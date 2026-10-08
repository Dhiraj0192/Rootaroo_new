import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const checkoutSchema: ValidationSchemas = {
  // Unknown keys (price, quantity, ...) are stripped: the server picks the price (B4).
  body: z.object({ interval: z.enum(['month', 'year']), seats: z.number().int().min(5).max(10) }),
};

export const planChangeSchema: ValidationSchemas = checkoutSchema;

export const syncParamsSchema: ValidationSchemas = {
  params: z.object({ sessionId: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/, 'Invalid session id') }),
};


export const appleVerifySchema: ValidationSchemas = {
  body: z.object({ signedTransaction: z.string().min(20).max(20_000) }),
};

export const googleVerifySchema: ValidationSchemas = {
  body: z.object({ purchaseToken: z.string().min(10).max(2048), productId: z.string().regex(/^rootaroo\.hh(10|[5-9])(\.(month|year))?$/, 'Invalid product id') }),
};
