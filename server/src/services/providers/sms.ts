import { getTwilioClient } from '../../config/twilio';
import { env } from '../../config/env';
import logger from '../../shared/utils/logger';
import type { SmsProvider } from '../types';

export const twilioSms: SmsProvider = {
  name: 'twilio',
  async send(to, body) {
    const client = getTwilioClient();
    if (!client) {
      throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing)');
    }
    await client.messages.create({ body, from: env.twilio.fromNumber, to });
  },
};

// Logs the recipient only: the body is a live sign-in code.
export const logSms: SmsProvider = {
  name: 'log',
  async send(to) {
    logger.info(`[Sms:log] to=${to}`);
  },
};

export const disabledSms: SmsProvider = {
  name: 'disabled',
  async send() {
    throw new Error('SMS is disabled');
  },
};
