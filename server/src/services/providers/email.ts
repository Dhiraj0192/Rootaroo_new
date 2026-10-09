import { getResendClient } from '../../config/resend';
import { env } from '../../config/env';
import logger from '../../shared/utils/logger';
import type { EmailProvider } from '../types';

export const resendEmail: EmailProvider = {
  name: 'resend',
  async send({ to, subject, text }) {
    const client = getResendClient();
    if (!client) {
      throw new Error('Resend is not configured (RESEND_API_KEY missing)');
    }

    // Resend's SDK never throws for API-level failures (bad/unverified
    // domain, rate limit, invalid recipient, etc.) — it always resolves
    // with { data, error }, even for network errors. Must check `error`
    // explicitly and throw ourselves, or every failed send silently looks
    // like success to callers relying on try/catch.
    const { error } = await client.emails.send({ from: env.emailFrom, to, subject, text });
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  },
};

// Never logs the body: it carries live verification and reset codes.
export const logEmail: EmailProvider = {
  name: 'log',
  async send({ to, subject }) {
    logger.info(`[Email:log] to=${to} subject=${subject}`);
  },
};
