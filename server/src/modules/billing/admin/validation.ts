import { z } from 'zod';
import type { ValidationSchemas } from '../../../shared/middleware/validate';

export const modeSchema = z.enum(['test', 'live']).default('live');
export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);
export const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).optional();
export const pingSchema: ValidationSchemas = {};
