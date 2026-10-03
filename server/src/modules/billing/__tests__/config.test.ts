jest.mock('stripe', () => jest.fn().mockImplementation((key: string, opts: unknown) => ({ __key: key, __opts: opts })));

import {
  loadBillingConfig, getStripe, isModeAvailable, __setBillingConfigForTests, STRIPE_API_VERSION, DEFAULT_INTEGRATION_ID,
} from '../config';
import { BillingUnavailableError } from '../errors';
import { fakeKey, fakeWebhookSecret } from '../../../test/billing/secrets';
import { testBillingConfig } from '../../../test/billing/config';

const base = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  STRIPE_TEST_SECRET_KEY: fakeKey('sk_test'),
  STRIPE_TEST_WEBHOOK_SECRETS: fakeWebhookSecret(),
  ...extra,
});

const prod = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  BILLING_ENV_TAG: 'prod',
  BILLING_PUBLIC_BASE_URL: 'https://api.rootaroo.com',
  STRIPE_TEST_SECRET_KEY: fakeKey('rk_test'),
  STRIPE_TEST_WEBHOOK_SECRETS: fakeWebhookSecret('t'),
  STRIPE_LIVE_SECRET_KEY: fakeKey('rk_live'),
  STRIPE_LIVE_WEBHOOK_SECRETS: fakeWebhookSecret('l'),
  ...extra,
});

describe('loadBillingConfig', () => {
  it('loads a dev config with test mode only and sensible defaults', () => {
    const cfg = loadBillingConfig(base());
    expect(cfg.envTag).toBe('dev');
    expect(cfg.graceDays).toBe(7);
    expect(cfg.integrationId).toBe(DEFAULT_INTEGRATION_ID);
    expect(cfg.modes.test).toEqual({ secretKey: fakeKey('sk_test'), webhookSecrets: [fakeWebhookSecret()] });
    expect(cfg.modes.live).toBeNull();
  });

  it('requires ToS consent by default; the flag can only be turned off outside production', () => {
    expect(loadBillingConfig(base()).requireTosConsent).toBe(true);
    const off = loadBillingConfig(base({ BILLING_REQUIRE_TOS_CONSENT: 'false' }));
    expect(off.requireTosConsent).toBe(false);
    expect(off.warnings.join(' ')).toMatch(/Terms of Service/);
    expect(() => loadBillingConfig(prod({ BILLING_REQUIRE_TOS_CONSENT: 'false' }))).toThrow(/BILLING_REQUIRE_TOS_CONSENT/);
    expect(() => loadBillingConfig(base({ BILLING_REQUIRE_TOS_CONSENT: 'maybe' }))).toThrow(/true or false/);
  });

  it('accepts two comma-separated webhook secrets for rotation', () => {
    const cfg = loadBillingConfig(base({ STRIPE_TEST_WEBHOOK_SECRETS: `${fakeWebhookSecret('a')}, ${fakeWebhookSecret('b')}` }));
    expect(cfg.modes.test!.webhookSecrets).toEqual([fakeWebhookSecret('a'), fakeWebhookSecret('b')]);
  });

  it('refuses a live key in the test variable', () => {
    expect(() => loadBillingConfig(base({ STRIPE_TEST_SECRET_KEY: fakeKey('sk_live') }))).toThrow(/not a test key/);
  });

  it('refuses a test key in the live variable', () => {
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_SECRET_KEY: fakeKey('sk_test') }))).toThrow(/not a live key/);
  });

  it('refuses any STRIPE_LIVE_* outside production', () => {
    expect(() => loadBillingConfig(base({ STRIPE_LIVE_WEBHOOK_SECRETS: fakeWebhookSecret() }))).toThrow(/outside production/);
  });

  it('refuses production without live key or secrets', () => {
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_SECRET_KEY: undefined }))).toThrow(/requires STRIPE_LIVE/);
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_WEBHOOK_SECRETS: '' }))).toThrow(/requires STRIPE_LIVE/);
  });

  it('refuses production unless BILLING_ENV_TAG is prod', () => {
    expect(() => loadBillingConfig(prod({ BILLING_ENV_TAG: 'dev' }))).toThrow(/must be 'prod'/);
  });

  it('refuses a short billing admin key', () => {
    expect(() => loadBillingConfig(base({ ADMIN_BILLING_API_KEY: 'short' }))).toThrow(/at least 32/);
  });

  it('refuses identical admin and billing keys (Review Focus 4)', () => {
    const same = 'k'.repeat(40);
    expect(() => loadBillingConfig(base({ ADMIN_BILLING_API_KEY: same, ADMIN_API_KEY: same }))).toThrow(/must differ/);
  });

  it('disables test mode with a warning when the test key is missing', () => {
    const cfg = loadBillingConfig(base({ STRIPE_TEST_SECRET_KEY: '' }));
    expect(cfg.modes.test).toBeNull();
    expect(cfg.warnings.join(' ')).toMatch(/test mode disabled/);
  });

  it('refuses a malformed integration identifier', () => {
    expect(() => loadBillingConfig(base({ STRIPE_INTEGRATION_ID: 'rootaroo_app_checkout_ABC' }))).toThrow(/STRIPE_INTEGRATION_ID/);
  });

  it('parses the IP allowlist', () => {
    expect(loadBillingConfig(base({ ADMIN_BILLING_IP_ALLOWLIST: '10.0.0.0/8, 203.0.113.7/32' })).adminIpAllowlist)
      .toEqual(['10.0.0.0/8', '203.0.113.7/32']);
  });
});

describe('getStripe', () => {
  afterEach(() => __setBillingConfigForTests(null));

  it('builds one pinned client per mode', () => {
    __setBillingConfigForTests(testBillingConfig());
    const a = getStripe('test') as any;
    const b = getStripe('test') as any;
    expect(a).toBe(b);
    expect(a.__key).toBe(fakeKey('sk_test'));
    expect(a.__opts).toMatchObject({ apiVersion: STRIPE_API_VERSION });
  });

  it('throws BillingUnavailableError for a disabled mode', () => {
    __setBillingConfigForTests(testBillingConfig());
    expect(isModeAvailable('live')).toBe(false);
    expect(() => getStripe('live')).toThrow(BillingUnavailableError);
  });
});
