/* eslint-disable no-console */
import path from 'path';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../config';
import {
  INTERVALS, LAUNCH_FORMULA, LAUNCH_PRICE_SET, PriceFormula, SEAT_SIZES, amountFor, bustCatalogCache, lookupKey,
} from '../catalog';
import type { BillingMode } from '../types';

export interface BootstrapOptions {
  mode: BillingMode;
  confirmLive: boolean;
  skipWebhooks: boolean;
  setPrices: { priceSet: string; formula: PriceFormula } | null;
  migratePrices: { from: string; to: string; noticeDays: number } | null;
  backfill: boolean;
}

export const PORTAL_METADATA = { rootaroo_portal: 'v1' };

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.pending_update_applied', 'customer.subscription.pending_update_expired',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required',
  'refund.created', 'refund.updated', 'refund.failed',
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated',
  'radar.early_fraud_warning.created', 'customer.updated',
];

const PRICE_SET_RE = /^\d{4}-\d{2}$/;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function intFlag(argv: string[], name: string): number {
  const raw = flag(argv, name);
  const v = Number(raw);
  if (raw === undefined || !Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer number of cents`);
  return v;
}

export function parseArgs(argv: string[]): BootstrapOptions {
  const mode = flag(argv, '--mode');
  if (mode !== 'test' && mode !== 'live') throw new Error('--mode must be test or live');
  const confirmLive = argv.includes('--confirm-live');
  if (mode === 'live' && !confirmLive) throw new Error('live mode requires --confirm-live');

  let setPrices: BootstrapOptions['setPrices'] = null;
  const set = flag(argv, '--set-prices');
  if (set !== undefined) {
    if (!PRICE_SET_RE.test(set)) throw new Error('price set must look like YYYY-MM');
    setPrices = {
      priceSet: set,
      formula: {
        monthBase: intFlag(argv, '--month-base'), monthExtra: intFlag(argv, '--month-extra'),
        yearBase: intFlag(argv, '--year-base'), yearExtra: intFlag(argv, '--year-extra'),
      },
    };
  }

  let migratePrices: BootstrapOptions['migratePrices'] = null;
  if (argv.includes('--migrate-prices')) {
    const from = flag(argv, '--from');
    const to = flag(argv, '--to');
    if (!from || !to || !PRICE_SET_RE.test(from) || !PRICE_SET_RE.test(to)) throw new Error('--migrate-prices needs --from YYYY-MM --to YYYY-MM');
    const noticeDays = Number(flag(argv, '--notice-days') ?? '30');
    if (!Number.isInteger(noticeDays) || noticeDays < 30) throw new Error('--notice-days must be an integer >= 30');
    migratePrices = { from, to, noticeDays };
  }

  return { mode, confirmLive, skipWebhooks: argv.includes('--skip-webhooks'), setPrices, migratePrices, backfill: argv.includes('--backfill') };
}

export async function ensureProducts(stripe: Stripe): Promise<Map<number, string>> {
  const existing = await stripe.products.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 1000 });
  const map = new Map<number, string>();
  for (const p of existing) {
    if (p.metadata?.rootaroo_catalog === 'household') map.set(Number(p.metadata.seats), p.id);
  }
  for (const seats of SEAT_SIZES) {
    if (map.has(seats)) continue;
    const created = await stripe.products.create(
      { name: `Rootaroo Household: ${seats} members`, metadata: { rootaroo_catalog: 'household', seats: String(seats) } },
      { idempotencyKey: `bootstrap:product:hh${seats}` },
    );
    map.set(seats, created.id);
  }
  return map;
}

export async function ensurePrices(
  stripe: Stripe, products: Map<number, string>, priceSet: string, formula: PriceFormula, transfer: boolean,
): Promise<Array<{ key: string; action: 'created' | 'exists' }>> {
  const out: Array<{ key: string; action: 'created' | 'exists' }> = [];
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      const key = lookupKey(interval, seats);
      const amount = amountFor(formula, interval, seats);
      const current = (await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })).data[0];
      if (current && current.metadata?.price_set === priceSet && current.unit_amount === amount) {
        out.push({ key, action: 'exists' });
        continue;
      }
      if (current && !transfer) {
        throw new Error(`${key} already points at ${current.id} (${current.unit_amount}, set ${current.metadata?.price_set}). Use --set-prices to move it.`);
      }
      const product = products.get(seats);
      if (!product) throw new Error(`product for ${seats} seats missing`);
      await stripe.prices.create({
        product, currency: 'usd', unit_amount: amount, recurring: { interval },
        lookup_key: key, tax_behavior: 'exclusive', nickname: `${key} ${priceSet}`,
        metadata: { price_set: priceSet, seats: String(seats), interval },
        ...(transfer ? { transfer_lookup_key: true } : {}),
      }, { idempotencyKey: `bootstrap:price:${priceSet}:${key}:${amount}` });
      out.push({ key, action: 'created' });
    }
  }
  return out;
}

export async function ensurePortalConfiguration(stripe: Stripe, returnUrl: string): Promise<{ id: string; action: 'created' | 'updated' }> {
  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: false },
    subscription_update: { enabled: false },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: {
        enabled: true,
        options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'],
      },
    },
  };
  const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 500 });
  const mine = configs.find((c) => c.metadata?.rootaroo_portal === PORTAL_METADATA.rootaroo_portal);
  if (mine) {
    await stripe.billingPortal.configurations.update(mine.id, { features, default_return_url: returnUrl });
    return { id: mine.id, action: 'updated' };
  }
  const created = await stripe.billingPortal.configurations.create({
    features, default_return_url: returnUrl, metadata: PORTAL_METADATA,
    business_profile: { headline: 'Manage your Rootaroo subscription' },
  });
  return { id: created.id, action: 'created' };
}

export async function ensureWebhookEndpoint(
  stripe: Stripe, mode: BillingMode, baseUrl: string,
): Promise<{ id: string; action: 'created' | 'updated' | 'skipped' }> {
  if (!baseUrl.startsWith('https://')) return { id: '', action: 'skipped' };
  const url = `${baseUrl}/api/v1/billing/webhooks/stripe/${mode}`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 }).autoPagingToArray({ limit: 500 });
  const existing = endpoints.find((e) => e.url === url);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    return { id: existing.id, action: 'updated' };
  }
  const created = await stripe.webhookEndpoints.create({
    url, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_API_VERSION,
    description: `Rootaroo ${mode} billing`, metadata: { rootaroo: 'v1' },
  });
  return { id: created.id, action: 'created' };
}

function bootstrapKey(mode: BillingMode): string {
  const key = mode === 'test'
    ? process.env.STRIPE_BOOTSTRAP_TEST_KEY || process.env.STRIPE_TEST_SECRET_KEY || ''
    : process.env.STRIPE_BOOTSTRAP_LIVE_KEY || process.env.STRIPE_LIVE_SECRET_KEY || '';
  const re = mode === 'test' ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/;
  if (!re.test(key)) throw new Error(`no ${mode} key configured (STRIPE_BOOTSTRAP_${mode.toUpperCase()}_KEY or the runtime key)`);
  return key;
}

export async function main(argv: string[]): Promise<void> {
  dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
  const opts = parseArgs(argv);
  if (opts.backfill) {
    const { setupAssociations } = await import('../../../database/models');
    const { runReconciliation } = await import('../reconcile');
    setupAssociations();
    const run = await runReconciliation(opts.mode, 'weekly');
    console.log(`backfill (weekly reconciliation) ${run.id}: ${run.status} ${JSON.stringify(run.counts)}`);
    return;
  }
  if (opts.migratePrices) {
    const { setupAssociations } = await import('../../../database/models');
    const { scheduleMigration } = await import('../priceNotices');
    setupAssociations();
    const r = await scheduleMigration(opts.mode, opts.migratePrices.from, opts.migratePrices.to, opts.migratePrices.noticeDays);
    console.log(`migrate-prices ${opts.migratePrices.from} -> ${opts.migratePrices.to}: ${r.scheduled} scheduled, ${r.skipped} skipped`);
    return;
  }
  const stripe = new Stripe(bootstrapKey(opts.mode), { apiVersion: STRIPE_API_VERSION });
  const base = (process.env.BILLING_PUBLIC_BASE_URL || process.env.SERVER_BASE_URL || '').replace(/\/+$/, '');

  const products = await ensureProducts(stripe);
  console.log(`products: ${[...products.entries()].map(([s, id]) => `${s}=${id}`).join(' ')}`);

  if (opts.setPrices) {
    const res = await ensurePrices(stripe, products, opts.setPrices.priceSet, opts.setPrices.formula, true);
    console.log(`set-prices ${opts.setPrices.priceSet}: ${res.filter((r) => r.action === 'created').length} created`);
  } else {
    const res = await ensurePrices(stripe, products, LAUNCH_PRICE_SET, LAUNCH_FORMULA, false);
    console.log(`prices: ${res.map((r) => `${r.key}:${r.action}`).join(' ')}`);
  }
  await bustCatalogCache(opts.mode);

  const portal = await ensurePortalConfiguration(stripe, `${base}/api/v1/billing/return/portal`);
  console.log(`portal configuration ${portal.id}: ${portal.action}`);

  if (!opts.skipWebhooks) {
    const wh = await ensureWebhookEndpoint(stripe, opts.mode, base);
    if (wh.action === 'skipped') console.log('webhook endpoint skipped (base URL is not https); use `stripe listen` locally');
    else console.log(`webhook endpoint ${wh.id}: ${wh.action}. Reveal its signing secret in the Dashboard and add it to STRIPE_${opts.mode.toUpperCase()}_WEBHOOK_SECRETS.`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async () => { (await import('../../../config/redis')).default.disconnect(); })
    .catch(async (err) => {
      console.error(`bootstrap failed: ${err.message}`);
      (await import('../../../config/redis')).default.disconnect();
      process.exit(1);
    });
}
