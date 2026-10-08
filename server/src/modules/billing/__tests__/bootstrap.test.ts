jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end', disconnect: jest.fn() } }));

import {
  parseArgs, ensureProducts, ensurePrices, ensurePortalConfiguration, ensureWebhookEndpoint, WEBHOOK_EVENTS,
} from '../scripts/stripe-bootstrap';
import { makeStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice } from '../../../test/billing/fixtures';
import { LAUNCH_FORMULA } from '../catalog';

const asStripe = (m: unknown) => m as any;

describe('parseArgs', () => {
  it('requires --confirm-live for live', () => {
    expect(() => parseArgs(['--mode', 'live'])).toThrow(/--confirm-live/);
    expect(parseArgs(['--mode', 'live', '--confirm-live']).mode).toBe('live');
  });

  it('parses --set-prices with all four amounts', () => {
    const o = parseArgs(['--mode', 'test', '--set-prices', '2027-01', '--month-base', '999', '--month-extra', '249', '--year-base', '8999', '--year-extra', '2988']);
    expect(o.setPrices).toEqual({ priceSet: '2027-01', formula: { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 } });
  });

  it('rejects --set-prices with missing or non-integer amounts', () => {
    expect(() => parseArgs(['--mode', 'test', '--set-prices', '2027-01', '--month-base', '9.99'])).toThrow();
  });

  it('rejects unknown modes and malformed price sets', () => {
    expect(() => parseArgs(['--mode', 'prod'])).toThrow();
    expect(() => parseArgs(['--mode', 'test', '--set-prices', 'jan', '--month-base', '1', '--month-extra', '1', '--year-base', '1', '--year-extra', '1'])).toThrow(/price set/);
  });
});

describe('ensureProducts', () => {
  it('creates missing products and reuses existing ones', async () => {
    const s = makeStripeMock();
    s.products.list.mockReturnValue(listOf([{ id: 'prod_5', metadata: { rootaroo_catalog: 'household', seats: '5' } }]));
    s.products.create.mockImplementation(async (p: any) => ({ id: `prod_${p.metadata.seats}` }));
    const map = await ensureProducts(asStripe(s));
    expect(map.get(5)).toBe('prod_5');
    expect(s.products.create).toHaveBeenCalledTimes(5);
    expect(s.products.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rootaroo Household: 7 members', metadata: { rootaroo_catalog: 'household', seats: '7' } }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });
});

describe('ensurePrices', () => {
  const products = new Map([5, 6, 7, 8, 9, 10].map((n) => [n, `prod_${n}`]));

  it('creates all 12 launch prices with metadata, lookup keys and exclusive tax', async () => {
    const s = makeStripeMock();
    s.prices.list.mockReturnValue(listOf([]));
    s.prices.create.mockResolvedValue({ id: 'price_x' });
    const res = await ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false);
    expect(res.filter((r) => r.action === 'created')).toHaveLength(12);
    expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      product: 'prod_7', unit_amount: 12775, currency: 'usd', recurring: { interval: 'year' },
      lookup_key: 'rootaroo_hh7_year', tax_behavior: 'exclusive',
      metadata: { price_set: '2026-10', seats: '7', interval: 'year' },
    }), expect.anything());
    expect(s.prices.create.mock.calls[0][0]).not.toHaveProperty('transfer_lookup_key');
  });

  it('is idempotent when every lookup key already points at the same set and amount', async () => {
    const s = makeStripeMock();
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    const res = await ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false);
    expect(res.every((r) => r.action === 'exists')).toBe(true);
    expect(s.prices.create).not.toHaveBeenCalled();
  });

  it('refuses to silently change an existing amount without --set-prices', async () => {
    const s = makeStripeMock();
    s.prices.list.mockReturnValue(listOf([stripePrice({ seats: 5, interval: 'month', amount: 100 })]));
    await expect(ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false)).rejects.toThrow(/--set-prices/);
  });

  it('--set-prices transfers lookup keys to a new set', async () => {
    const s = makeStripeMock();
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    s.prices.create.mockResolvedValue({ id: 'price_new' });
    const f = { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 };
    await ensurePrices(asStripe(s), products, '2027-01', f, true);
    expect(s.prices.create).toHaveBeenCalledTimes(12);
    expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      lookup_key: 'rootaroo_hh5_month', transfer_lookup_key: true, unit_amount: 999, metadata: expect.objectContaining({ price_set: '2027-01' }),
    }), expect.anything());
  });
});

describe('ensurePortalConfiguration', () => {
  it('creates a configuration with plan switching off and end-of-period cancel', async () => {
    const s = makeStripeMock();
    s.billingPortal.configurations.list.mockReturnValue(listOf([]));
    s.billingPortal.configurations.create.mockResolvedValue({ id: 'bpc_1' });
    await expect(ensurePortalConfiguration(asStripe(s), 'https://x/api/v1/billing/return/portal')).resolves.toEqual({ id: 'bpc_1', action: 'created' });
    const params = s.billingPortal.configurations.create.mock.calls[0][0] as any;
    expect(params.features.subscription_update.enabled).toBe(false);
    expect(params.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true } });
    expect(params.features.payment_method_update.enabled).toBe(true);
    expect(params.features.invoice_history.enabled).toBe(true);
    expect(params.metadata).toEqual({ rootaroo_portal: 'v1' });
  });

  it('updates the existing tagged configuration', async () => {
    const s = makeStripeMock();
    s.billingPortal.configurations.list.mockReturnValue(listOf([{ id: 'bpc_9', metadata: { rootaroo_portal: 'v1' } }]));
    s.billingPortal.configurations.update.mockResolvedValue({ id: 'bpc_9' });
    await expect(ensurePortalConfiguration(asStripe(s), 'https://x')).resolves.toEqual({ id: 'bpc_9', action: 'updated' });
  });
});

describe('ensureWebhookEndpoint', () => {
  it('subscribes only to the §8.5 events, pinned to the API version', async () => {
    const s = makeStripeMock();
    s.webhookEndpoints.list.mockReturnValue(listOf([]));
    s.webhookEndpoints.create.mockResolvedValue({ id: 'we_1' });
    await ensureWebhookEndpoint(asStripe(s), 'test', 'https://api.example.test');
    expect(s.webhookEndpoints.create).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example.test/api/v1/billing/webhooks/stripe/test',
      enabled_events: WEBHOOK_EVENTS, api_version: '2026-09-30.endive',
    }));
    expect(WEBHOOK_EVENTS).toHaveLength(22);
  });

  it('updates an existing endpoint with the same URL', async () => {
    const s = makeStripeMock();
    s.webhookEndpoints.list.mockReturnValue(listOf([{ id: 'we_2', url: 'https://api.example.test/api/v1/billing/webhooks/stripe/test' }]));
    s.webhookEndpoints.update.mockResolvedValue({ id: 'we_2' });
    await expect(ensureWebhookEndpoint(asStripe(s), 'test', 'https://api.example.test')).resolves.toEqual({ id: 'we_2', action: 'updated' });
  });

  it('skips non-https bases (local dev uses stripe listen)', async () => {
    const s = makeStripeMock();
    await expect(ensureWebhookEndpoint(asStripe(s), 'test', 'http://localhost:3000')).resolves.toEqual({ id: '', action: 'skipped' });
    expect(s.webhookEndpoints.create).not.toHaveBeenCalled();
  });
});
