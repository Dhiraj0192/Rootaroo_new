import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const deviceTokenSchema: ValidationSchemas = {
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    platform: z.enum(['ios', 'android', 'web']),
  }),
};

export const updatePreferencesSchema: ValidationSchemas = {
  body: z.object({
    newPost: z.boolean().optional(),
    taskAssigned: z.boolean().optional(),
    taskCompleted: z.boolean().optional(),
    checkIn: z.boolean().optional(),
    newExpense: z.boolean().optional(),
    chatMessage: z.boolean().optional(),
    pingRequest: z.boolean().optional(),
    calendarEvent: z.boolean().optional(),
    memberJoined: z.boolean().optional(),
    tips: z.boolean().optional(),
  }),
};
