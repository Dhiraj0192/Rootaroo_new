import winston from 'winston';
import { env } from '../../config/env';

/** Stripe secret/restricted keys and webhook signing secrets (spec §4.2). */
export const SECRET_PATTERN = /(sk|rk)_(test|live)_\w+|whsec_\w+/g;

export function redactSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, '[REDACTED]');
}

export function deepRedact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactSecrets(value.stack) : undefined;
    return copy;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = deepRedact(v, depth + 1);
  return out;
}

export const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    (info as Record<string, unknown>)[key] = deepRedact((info as Record<string, unknown>)[key]);
  }
  const splat = Symbol.for('splat');
  const rec = info as unknown as Record<symbol, unknown>;
  if (Array.isArray(rec[splat])) rec[splat] = (rec[splat] as unknown[]).map((v) => deepRedact(v));
  return info;
});

const logger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    env.nodeEnv === 'development'
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            return `${timestamp} [${level}]: ${message}${stack ? '\n' + stack : ''}`;
          })
        )
      : winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
