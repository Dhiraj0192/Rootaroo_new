import logger from '../../shared/utils/logger';
import type { ErrorReporter } from '../types';

export const consoleReporter: ErrorReporter = {
  name: 'console',
  capture(err, context) {
    logger.error('[Error]', err, context ?? {});
  },
};

// Loaded lazily so the SDK is only pulled in (and initialised) when selected.
let sentry: typeof import('@sentry/node') | null = null;

function client(): typeof import('@sentry/node') {
  if (!sentry) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sentry = require('@sentry/node') as typeof import('@sentry/node');
    sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
  }
  return sentry;
}

export const sentryReporter: ErrorReporter = {
  name: 'sentry',
  capture(err, context) {
    try {
      client().captureException(err, { extra: context });
    } catch (e) {
      logger.error('[Sentry] capture failed:', (e as Error).message);
    }
  },
};
