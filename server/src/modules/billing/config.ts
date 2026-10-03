import Stripe from 'stripe';
import logger from '../../shared/utils/logger';
import { BillingUnavailableError } from './errors';
import { assertIapConfig } from './iap/config';
import type { BillingMode } from './types';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
/** Spec §4.2: fixed integration label, 8 random letters chosen once. */
export const DEFAULT_INTEGRATION_ID = 'rootaroo_app_checkout_qhzmvtkd';

export type EnvTag = 'dev' | 'staging' | 'prod';
export interface ModeConfig { secretKey: string; webhookSecrets: string[] }
export interface BillingConfig {
  nodeEnv: string;
  envTag: EnvTag;
  graceDays: number;
  publicBaseUrl: string;
  integrationId: string;
  /** Checkout shows a required Terms of Service checkbox. Needs a ToS URL in the Stripe dashboard. */
  requireTosConsent: boolean;
  adminKey: string;
  adminIpAllowlist: string[];
  modes: Record<BillingMode, ModeConfig | null>;
  warnings: string[];
}

export class BillingConfigError extends Error {}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]+$/;

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadBillingConfig(src: NodeJS.ProcessEnv): BillingConfig {
  const nodeEnv = src.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  const envTag = (src.BILLING_ENV_TAG || (isProd ? '' : 'dev')) as EnvTag;
  if (!['dev', 'staging', 'prod'].includes(envTag)) errors.push('BILLING_ENV_TAG must be dev, staging or prod');
  if (isProd && envTag !== 'prod') errors.push("BILLING_ENV_TAG must be 'prod' in production");

  const testKey = src.STRIPE_TEST_SECRET_KEY || '';
  const testSecrets = list(src.STRIPE_TEST_WEBHOOK_SECRETS);
  const liveKey = src.STRIPE_LIVE_SECRET_KEY || '';
  const liveSecrets = list(src.STRIPE_LIVE_WEBHOOK_SECRETS);

  if (testKey && !TEST_KEY.test(testKey)) errors.push('STRIPE_TEST_SECRET_KEY is not a test key');
  if (liveKey && !LIVE_KEY.test(liveKey)) errors.push('STRIPE_LIVE_SECRET_KEY is not a live key');
  if ([...testSecrets, ...liveSecrets].some((s) => !WEBHOOK_SECRET.test(s))) {
    errors.push('webhook secrets must look like whsec_...');
  }
  if (!isProd && (liveKey || liveSecrets.length > 0)) errors.push('STRIPE_LIVE_* must not be set outside production');
  if (isProd && (!liveKey || liveSecrets.length === 0)) {
    errors.push('production requires STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_WEBHOOK_SECRETS');
  }

  const adminKey = src.ADMIN_BILLING_API_KEY || '';
  if (adminKey && adminKey.length < 32) errors.push('ADMIN_BILLING_API_KEY must be at least 32 characters');
  if (adminKey && src.ADMIN_API_KEY && adminKey === src.ADMIN_API_KEY) {
    errors.push('ADMIN_BILLING_API_KEY must differ from ADMIN_API_KEY');
  }

  const graceDays = Number(src.BILLING_GRACE_DAYS || '7');
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) errors.push('BILLING_GRACE_DAYS must be an integer 0..30');

  const fallbackBase = src.SERVER_BASE_URL || `http://localhost:${src.PORT || '3000'}`;
  const publicBaseUrl = (src.BILLING_PUBLIC_BASE_URL || (isProd ? '' : fallbackBase)).replace(/\/+$/, '');
  if (isProd && !publicBaseUrl.startsWith('https://')) errors.push('BILLING_PUBLIC_BASE_URL must be an https origin in production');

  const integrationId = src.STRIPE_INTEGRATION_ID || DEFAULT_INTEGRATION_ID;
  if (!/^rootaroo_app_checkout_[a-z]{8}$/.test(integrationId)) {
    errors.push('STRIPE_INTEGRATION_ID must be rootaroo_app_checkout_<8 lowercase letters>');
  }

  const tosRaw = (src.BILLING_REQUIRE_TOS_CONSENT || 'true').toLowerCase();
  if (!['true', 'false'].includes(tosRaw)) errors.push('BILLING_REQUIRE_TOS_CONSENT must be true or false');
  const requireTosConsent = tosRaw !== 'false';
  if (isProd && !requireTosConsent) errors.push('BILLING_REQUIRE_TOS_CONSENT must not be false in production');
  if (!requireTosConsent) warnings.push('BILLING_REQUIRE_TOS_CONSENT=false: Checkout will not show the Terms of Service checkbox');

  if (!testKey) warnings.push('STRIPE_TEST_SECRET_KEY is not set: test mode disabled (test-cohort households still bypass the paywall)');
  else if (testSecrets.length === 0) warnings.push('STRIPE_TEST_WEBHOOK_SECRETS is not set: test webhooks will be rejected');

  if (errors.length > 0) throw new BillingConfigError(errors.join('; '));

  return {
    nodeEnv,
    envTag,
    graceDays,
    publicBaseUrl,
    integrationId,
    requireTosConsent,
    adminKey,
    adminIpAllowlist: list(src.ADMIN_BILLING_IP_ALLOWLIST),
    modes: {
      test: testKey ? { secretKey: testKey, webhookSecrets: testSecrets } : null,
      live: liveKey ? { secretKey: liveKey, webhookSecrets: liveSecrets } : null,
    },
    warnings,
  };
}

let cached: BillingConfig | null = null;
const clients: Partial<Record<BillingMode, Stripe>> = {};

export function getBillingConfig(): BillingConfig {
  if (!cached) cached = loadBillingConfig(process.env);
  return cached;
}

export function isModeAvailable(mode: BillingMode): boolean {
  return getBillingConfig().modes[mode] !== null;
}

export function getStripe(mode: BillingMode): Stripe {
  const existing = clients[mode];
  if (existing) return existing;
  const modeCfg = getBillingConfig().modes[mode];
  if (!modeCfg) throw new BillingUnavailableError();
  const client = new Stripe(modeCfg.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'rootaroo-server' },
  });
  clients[mode] = client;
  return client;
}

/** Called first thing in index.ts start(): refuses to boot on a bad billing config (§4.2). */
export function assertBillingConfigAtStartup(): void {
  try {
    const cfg = getBillingConfig();
    for (const w of cfg.warnings) logger.warn(`[Billing] ${w}`);
    logger.info(`[Billing] env=${cfg.envTag} test=${cfg.modes.test ? 'on' : 'off'} live=${cfg.modes.live ? 'on' : 'off'}`);
    assertIapConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: billing configuration invalid: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function __setBillingConfigForTests(cfg: BillingConfig | null): void {
  cached = cfg;
  delete clients.test;
  delete clients.live;
}

export function __setStripeForTests(mode: BillingMode, client: unknown | null): void {
  if (client === null) delete clients[mode];
  else clients[mode] = client as Stripe;
}
