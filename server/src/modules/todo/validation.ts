import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

// 24-hour "HH:MM".
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const createTodoSchema: ValidationSchemas = {
  body: z.object({
    title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueTime: z.string().regex(TIME_OF_DAY).optional(),
    assignedTo: z.string().uuid().optional(),
  }),
};

export const updateTodoSchema: ValidationSchemas = {
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueTime: z.string().regex(TIME_OF_DAY).nullable().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
  }),
};
