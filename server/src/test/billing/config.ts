import { BillingConfig, DEFAULT_INTEGRATION_ID } from '../../modules/billing/config';
import { fakeKey, fakeWebhookSecret } from './secrets';

export function testBillingConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    nodeEnv: 'test',
    envTag: 'dev',
    graceDays: 7,
    publicBaseUrl: 'https://api.example.test',
    integrationId: DEFAULT_INTEGRATION_ID,
    requireTosConsent: true,
    adminKey: 'b'.repeat(40),
    adminIpAllowlist: [],
    modes: { test: { secretKey: fakeKey('sk_test'), webhookSecrets: [fakeWebhookSecret()] }, live: null },
    warnings: [],
    ...overrides,
  };
}
