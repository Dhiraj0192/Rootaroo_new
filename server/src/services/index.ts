import type {
  EmailProvider, ErrorReporter, KeyVaultProvider, PushProvider, Services, ServicesConfig, SmsProvider, StorageProvider, WeatherProvider,
} from './types';
import { resendEmail, logEmail } from './providers/email';
import { twilioSms, logSms, disabledSms } from './providers/sms';
import { expoPush, logPush } from './providers/push';
import { s3Storage } from './providers/storage';
import { openMeteoWeather } from './providers/weather';
import { createLocalKeyVault, awsKmsKeyVaultFromEnv, DEV_KEY_VAULT_SECRET } from './providers/keyVault';
import { sentryReporter, consoleReporter } from './providers/monitoring';

let services: Services | null = null;
let overrides: Partial<Services> = {};

export function initServices(config: ServicesConfig): void {
  overrides = {};
  services = {
    email: config.email === 'resend' ? resendEmail : logEmail,
    sms: config.sms === 'twilio' ? twilioSms : config.sms === 'log' ? logSms : disabledSms,
    push: config.push === 'expo' ? expoPush : logPush,
    storage: s3Storage,
    weather: openMeteoWeather,
    errors: config.monitoring === 'sentry' ? sentryReporter : consoleReporter,
    keyVault: config.keyVault === 'aws-kms'
      ? awsKmsKeyVaultFromEnv(process.env)
      : createLocalKeyVault(process.env.KEY_VAULT_LOCAL_SECRET || DEV_KEY_VAULT_SECRET),
  };
}

function resolve<K extends keyof Services>(key: K): Services[K] {
  const override = overrides[key];
  if (override) return override as Services[K];
  if (!services) throw new Error('Services not initialised');
  return services[key];
}

export const getEmail = (): EmailProvider => resolve('email');
export const getSms = (): SmsProvider => resolve('sms');
export const getPush = (): PushProvider => resolve('push');
export const getStorage = (): StorageProvider => resolve('storage');
export const getWeather = (): WeatherProvider => resolve('weather');
export const getKeyVault = (): KeyVaultProvider => resolve('keyVault');
export const getErrorReporter = (): ErrorReporter => resolve('errors');

/** Test seam: override individual providers. */
export function __setServicesForTests(partial: Partial<Record<keyof Services, unknown>>): void {
  overrides = { ...overrides, ...(partial as Partial<Services>) };
}

export function __resetServicesForTests(): void {
  overrides = {};
  services = null;
}

export type { ServicesConfig } from './types';
