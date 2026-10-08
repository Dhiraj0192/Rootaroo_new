import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const createPingRequestSchema: ValidationSchemas = {
  body: z.object({
    targetUserId: z.string().uuid(),
    note: z.string().max(500).nullable().optional(),
  }),
};

export const respondPingRequestSchema: ValidationSchemas = {
  body: z
    .object({
      action: z.enum(['accept', 'decline']),
      latitude: z.number().min(-90).max(90).nullable().optional(),
      longitude: z.number().min(-180).max(180).nullable().optional(),
      address: z.string().max(500).nullable().optional(),
      durationMinutes: z.number().int().positive().max(480).optional(),
    })
    .refine(
      (data) =>
        (data.latitude == null && data.longitude == null) ||
        (data.latitude != null && data.longitude != null),
      { message: 'Both latitude and longitude must be provided together', path: ['latitude'] },
    )
    .refine(
      (data) => data.action !== 'accept' || data.durationMinutes != null,
      { message: 'durationMinutes is required to accept a location request', path: ['durationMinutes'] },
    ),
};

export const pingQuerySchema: ValidationSchemas = {
  query: z.object({
    direction: z.enum(['incoming', 'outgoing']).default('incoming'),
    status: z.enum(['pending', 'fulfilled', 'declined', 'expired']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
};
