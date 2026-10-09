import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const deviceIdParamSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
};
