import { loadServicesConfig, describeServices } from '../config';

const dev = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'development', ...extra });
const prod = (extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  RESEND_API_KEY: 're_live_secret',
  TWILIO_ACCOUNT_SID: 'AC_secret',
  TWILIO_AUTH_TOKEN: 'tw_secret',
  TWILIO_PHONE_NUMBER: '+15550001111',
  KEY_VAULT_PROVIDER: 'aws-kms',
  KEY_VAULT_REGION: 'ap-south-1',
  KEY_VAULT_MAC_KEY_ID: 'arn:mac',
  KEY_VAULT_ENC_KEY_ID: 'arn:enc',
  ...extra,
});

describe('loadServicesConfig', () => {
  it('development without keys falls back to log providers and boots', () => {
    const { config, errors } = loadServicesConfig(dev());
    expect(errors).toEqual([]);
    expect(config).toEqual({
      email: 'log', sms: 'log', push: 'expo', storage: 's3', weather: 'open-meteo', monitoring: 'console', keyVault: 'local',
    });
  });

  it('defaults to the real vendor when its keys are present', () => {
    const { config } = loadServicesConfig(dev({
      RESEND_API_KEY: 'k', TWILIO_ACCOUNT_SID: 's', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+1', SENTRY_DSN: 'https://x@sentry.io/1',
    }));
    expect(config.email).toBe('resend');
    expect(config.sms).toBe('twilio');
    expect(config.monitoring).toBe('sentry');
  });

  it('an explicit provider wins over the default', () => {
    const { config } = loadServicesConfig(dev({ RESEND_API_KEY: 'k', EMAIL_PROVIDER: 'log' }));
    expect(config.email).toBe('log');
  });

  it('rejects unknown provider names', () => {
    const { errors } = loadServicesConfig(dev({ EMAIL_PROVIDER: 'mailgun' }));
    expect(errors).toContain('EMAIL_PROVIDER must be one of: resend, log');
  });

  it('rejects a chosen vendor whose keys are missing', () => {
    const { errors } = loadServicesConfig(dev({ EMAIL_PROVIDER: 'resend', SMS_PROVIDER: 'twilio', MONITORING_PROVIDER: 'sentry' }));
    expect(errors).toEqual(expect.arrayContaining([
      'EMAIL_PROVIDER=resend needs RESEND_API_KEY',
      'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER',
      'MONITORING_PROVIDER=sentry needs SENTRY_DSN',
    ]));
  });

  it('production refuses log providers for email, SMS and push', () => {
    const { errors } = loadServicesConfig(prod({ EMAIL_PROVIDER: 'log', SMS_PROVIDER: 'log', PUSH_PROVIDER: 'log' }));
    expect(errors).toEqual(expect.arrayContaining([
      'EMAIL_PROVIDER=log is not allowed in production',
      'SMS_PROVIDER=log is not allowed in production',
      'PUSH_PROVIDER=log is not allowed in production',
    ]));
  });

  it('production without Twilio keys turns SMS off instead of logging codes', () => {
    const { config, errors, warnings } = loadServicesConfig(prod({ TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '' }));
    expect(errors).toEqual([]);
    expect(config.sms).toBe('disabled');
    expect(warnings).toContain('SMS is disabled: phone sign-in codes cannot be sent');
  });

  it('a fully configured production boots', () => {
    const { config, errors } = loadServicesConfig(prod());
    expect(errors).toEqual([]);
    expect(config.email).toBe('resend');
    expect(config.sms).toBe('twilio');
  });
});

describe('describeServices', () => {
  it('lists each service and provider without leaking secrets', () => {
    const env = prod({ SENTRY_DSN: 'https://secretkey@sentry.io/1' });
    const text = describeServices(loadServicesConfig(env).config).join('\n');
    expect(text).toContain('email: resend');
    expect(text).toContain('sms: twilio');
    expect(text).toContain('monitoring: sentry');
    for (const secret of ['re_live_secret', 'AC_secret', 'tw_secret', 'secretkey']) {
      expect(text).not.toContain(secret);
    }
  });
});
