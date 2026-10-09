import type { ServicesConfig } from './types';

const OPTIONS = {
  EMAIL_PROVIDER: ['resend', 'log'],
  SMS_PROVIDER: ['twilio', 'log', 'disabled'],
  PUSH_PROVIDER: ['expo', 'log'],
  STORAGE_PROVIDER: ['s3'],
  WEATHER_PROVIDER: ['open-meteo'],
  MONITORING_PROVIDER: ['sentry', 'console'],
} as const;

type Var = keyof typeof OPTIONS;

/**
 * Pure: reads the given env, never process.env, so it is testable and the
 * caller decides what to do with errors (index.ts exits, like billing config).
 */
export function loadServicesConfig(src: NodeJS.ProcessEnv): {
  config: ServicesConfig;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = src.NODE_ENV === 'production';
  const rawVault = (src.KEY_VAULT_PROVIDER || '').trim().toLowerCase();

  const hasResend = !!src.RESEND_API_KEY;
  const hasTwilio = !!(src.TWILIO_ACCOUNT_SID && src.TWILIO_AUTH_TOKEN && src.TWILIO_PHONE_NUMBER);
  const hasSentry = !!src.SENTRY_DSN;

  const defaults: Record<Var, string> = {
    EMAIL_PROVIDER: hasResend ? 'resend' : 'log',
    SMS_PROVIDER: hasTwilio ? 'twilio' : isProd ? 'disabled' : 'log',
    PUSH_PROVIDER: 'expo',
    STORAGE_PROVIDER: 's3',
    WEATHER_PROVIDER: 'open-meteo',
    MONITORING_PROVIDER: hasSentry ? 'sentry' : 'console',
  };

  const pick = (name: Var): string => {
    const raw = (src[name] || '').trim().toLowerCase();
    if (!raw) return defaults[name];
    if (!(OPTIONS[name] as readonly string[]).includes(raw)) {
      errors.push(`${name} must be one of: ${OPTIONS[name].join(', ')}`);
      return defaults[name];
    }
    return raw;
  };

  const config = {
    email: pick('EMAIL_PROVIDER'),
    sms: pick('SMS_PROVIDER'),
    push: pick('PUSH_PROVIDER'),
    storage: pick('STORAGE_PROVIDER'),
    weather: pick('WEATHER_PROVIDER'),
    monitoring: pick('MONITORING_PROVIDER'),
    keyVault: (src.KEY_VAULT_PROVIDER || '').trim().toLowerCase() === 'aws-kms' ? 'aws-kms' : 'local',
  } as ServicesConfig;

  if (config.email === 'resend' && !hasResend) errors.push('EMAIL_PROVIDER=resend needs RESEND_API_KEY');
  if (config.sms === 'twilio' && !hasTwilio) {
    errors.push('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
  }
  if (config.monitoring === 'sentry' && !hasSentry) errors.push('MONITORING_PROVIDER=sentry needs SENTRY_DSN');

  if (rawVault && rawVault !== 'local' && rawVault !== 'aws-kms') {
    errors.push('KEY_VAULT_PROVIDER must be one of: local, aws-kms');
  }
  if (config.keyVault === 'aws-kms' && !(src.KEY_VAULT_REGION && src.KEY_VAULT_MAC_KEY_ID && src.KEY_VAULT_ENC_KEY_ID)) {
    errors.push('KEY_VAULT_PROVIDER=aws-kms needs KEY_VAULT_REGION, KEY_VAULT_MAC_KEY_ID, KEY_VAULT_ENC_KEY_ID');
  }
  if (config.keyVault === 'local' && src.KEY_VAULT_LOCAL_SECRET && src.KEY_VAULT_LOCAL_SECRET.length < 32) {
    errors.push('KEY_VAULT_LOCAL_SECRET must be at least 32 characters');
  }
  if (config.keyVault === 'local' && !isProd) {
    warnings.push('KEY_VAULT_PROVIDER=local: backups are protected by a development key only');
  }

  if (isProd) {
    if (!rawVault) errors.push('KEY_VAULT_PROVIDER must be set to local or aws-kms in production');
    if (config.keyVault === 'local' && rawVault === 'local') {
      const secret = src.KEY_VAULT_LOCAL_SECRET || '';
      if (secret.length < 64) errors.push('KEY_VAULT_LOCAL_SECRET must be at least 64 characters in production');
      for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CALENDAR_TOKEN_KEK']) {
        if (secret && secret === src[name]) errors.push(`KEY_VAULT_LOCAL_SECRET must differ from ${name}`);
      }
      warnings.push('KEY_VAULT_PROVIDER=local in production: backups are protected by a server secret; switch to aws-kms for hardware protection');
    }
    if (config.email === 'log') errors.push('EMAIL_PROVIDER=log is not allowed in production');
    if (config.sms === 'log') errors.push('SMS_PROVIDER=log is not allowed in production');
    if (config.push === 'log') errors.push('PUSH_PROVIDER=log is not allowed in production');
  }
  if (config.sms === 'disabled') warnings.push('SMS is disabled: phone sign-in codes cannot be sent');

  return { config, errors, warnings };
}

/** Provider names only, safe to log. */
export function describeServices(config: ServicesConfig): string[] {
  return Object.entries(config).map(([service, provider]) => `${service}: ${provider}`);
}
