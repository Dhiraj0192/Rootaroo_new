// Runs before any module import in every integration test file.
// server/.env.impl (gitignored, throwaway DB credentials) overrides server/.env when present; dotenv never overrides set vars.
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env.impl') });
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rootaroo_test';
if (!process.env.DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run integration tests against ${process.env.DB_NAME}`);
}
process.env.BILLING_ENV_TAG = process.env.BILLING_ENV_TAG || 'dev';
// Integration tests never call Stripe: tests install a mock client (installStripeMock).
process.env.STRIPE_TEST_SECRET_KEY = ['sk', 'test', 'integrationharness0000'].join('_');
process.env.STRIPE_TEST_WEBHOOK_SECRETS = ['whsec', 'integrationharness0000'].join('_');
delete process.env.STRIPE_LIVE_SECRET_KEY;
delete process.env.STRIPE_LIVE_WEBHOOK_SECRETS;
process.env.ADMIN_API_KEY = 'int-admin-key-0123456789abcdef0123456789';
process.env.ADMIN_BILLING_API_KEY = 'int-billing-key-0123456789abcdef01234567';
