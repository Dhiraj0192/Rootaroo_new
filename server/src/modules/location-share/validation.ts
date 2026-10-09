import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const accuracy = z.number().positive().nullable().optional();

export const startShareSchema: ValidationSchemas = {
  body: z.object({
    durationMinutes: z.number().int().min(1).max(480),
    viewerIds: z.array(z.string().uuid()).min(1).nullable(),
    latitude,
    longitude,
    accuracy,
  }),
};

export const updateShareLocationSchema: ValidationSchemas = {
  body: z.object({ latitude, longitude, accuracy }),
  params: z.object({ id: z.string().uuid() }),
};

export const shareIdParamSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
};
