import { parseProductId, productIdFor, normalizeHouseholdId } from '../types';
import { loadIapConfig, IapConfigError, normalizePem } from '../config';

describe('parseProductId', () => {
  it('parses rootaroo.hh{5..10}.{month|year}', () => {
    for (let n = 5; n <= 10; n++) {
      for (const interval of ['month', 'year'] as const) {
        expect(parseProductId(productIdFor(n, interval))).toEqual({ seats: n, interval });
      }
    }
  });

  it('accepts the Google form where the base plan carries the interval', () => {
    expect(parseProductId('rootaroo.hh7', 'year')).toEqual({ seats: 7, interval: 'year' });
    expect(parseProductId('rootaroo.hh7', 'weekly')).toBeNull();
    expect(parseProductId('rootaroo.hh7')).toBeNull();
  });

  it('rejects sizes outside 5..10 and foreign products', () => {
    for (const bad of ['rootaroo.hh4.month', 'rootaroo.hh11.year', 'rootaroo.hh05.month', 'other.hh5.month', 'rootaroo.hh5.week', '']) {
      expect(parseProductId(bad)).toBeNull();
    }
  });
});

describe('normalizeHouseholdId', () => {
  it('lowercases UUIDs and rejects everything else', () => {
    expect(normalizeHouseholdId('0A1B2C3D-0000-4000-8000-000000000001')).toBe('0a1b2c3d-0000-4000-8000-000000000001');
    expect(normalizeHouseholdId('not-a-uuid')).toBeNull();
    expect(normalizeHouseholdId(undefined)).toBeNull();
  });
});

describe('loadIapConfig', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----';
  const sa = JSON.stringify({ client_email: 'play@example.iam.test', private_key: 'x' });

  it('is fully optional: nothing set disables both stores with warnings', () => {
    const cfg = loadIapConfig({ NODE_ENV: 'development' });
    expect(cfg.apple).toBeNull();
    expect(cfg.google).toBeNull();
    expect(cfg.warnings).toHaveLength(2);
  });

  it('loads Apple with the default bundle id and unescapes the PEM', () => {
    const cfg = loadIapConfig({ APPLE_IAP_KEY_ID: 'KEY1', APPLE_IAP_ISSUER_ID: 'iss', APPLE_IAP_PRIVATE_KEY: pem, APPLE_APP_APPLE_ID: '12345' });
    expect(cfg.apple).toMatchObject({ keyId: 'KEY1', bundleId: 'com.rootaroo.app', appAppleId: 12345 });
    expect(cfg.apple!.privateKey).toContain('\n');
    expect(normalizePem('a\\nb')).toBe('a\nb');
  });

  it('refuses a half-set Apple or Google configuration', () => {
    expect(() => loadIapConfig({ APPLE_IAP_KEY_ID: 'KEY1' })).toThrow(IapConfigError);
    expect(() => loadIapConfig({ GOOGLE_PLAY_RTDN_AUDIENCE: 'https://x' })).toThrow(/must be set together/);
    expect(() => loadIapConfig({ APPLE_IAP_KEY_ID: 'k', APPLE_IAP_ISSUER_ID: 'i', APPLE_IAP_PRIVATE_KEY: 'nope' })).toThrow(/PKCS#8/);
  });

  it('requires the numeric app id in production and valid service account JSON', () => {
    const apple = { APPLE_IAP_KEY_ID: 'k', APPLE_IAP_ISSUER_ID: 'i', APPLE_IAP_PRIVATE_KEY: pem };
    expect(() => loadIapConfig({ NODE_ENV: 'production', ...apple })).toThrow(/APPLE_APP_APPLE_ID/);
    expect(() => loadIapConfig({ ...apple, APPLE_APP_APPLE_ID: 'abc' })).toThrow(/positive integer/);
    expect(() => loadIapConfig({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{nope', GOOGLE_PLAY_RTDN_AUDIENCE: 'a', GOOGLE_PLAY_RTDN_SA_EMAIL: 'e' })).toThrow(/not valid JSON/);
  });

  it('loads Google and defaults the package name', () => {
    const cfg = loadIapConfig({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: sa, GOOGLE_PLAY_RTDN_AUDIENCE: 'https://api.example.test/hook', GOOGLE_PLAY_RTDN_SA_EMAIL: 'push@example.iam.test' });
    expect(cfg.google).toMatchObject({ packageName: 'com.rootaroo.app', rtdnAudience: 'https://api.example.test/hook' });
  });
});
