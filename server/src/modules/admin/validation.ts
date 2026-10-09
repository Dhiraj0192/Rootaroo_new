import { z } from 'zod';
import { CAMPAIGN_SETTING_KEYS } from '../campaign/settings';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const reviewActionRequestSchema: ValidationSchemas = {
  body: z.object({
    reviewerNote: z.string().max(500, 'Note too long').optional(),
  }),
};

export const setCampaignSchema: ValidationSchemas = {
  params: z.object({ key: z.enum(CAMPAIGN_SETTING_KEYS) }),
  body: z.object({ enabled: z.boolean() }).strict(),
};
