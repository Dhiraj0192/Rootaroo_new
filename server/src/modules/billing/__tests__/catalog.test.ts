const redisMock: any = { status: 'end', publish: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

import {
  amountFor, lookupKey, LAUNCH_FORMULA, getCatalog, priceFor, findPriceInSet, bustCatalogCache, clearLocalCatalogCache,
  toCatalogPrice, assertSeats,
} from '../catalog';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice } from '../../../test/billing/fixtures';

let stripe: StripeMock;
beforeEach(() => {
  clearLocalCatalogCache();
  stripe = installStripeMock('test');
  const all = catalogPrices();
  stripe.prices.list.mockImplementation((p: { lookup_keys?: string[] }) =>
    listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys!.includes(x.lookup_key!)) : all));
});

describe('price formulas (§6.1, all 12 amounts)', () => {
  it.each([
    [5, 899, 7999], [6, 1098, 10387], [7, 1297, 12775], [8, 1496, 15163], [9, 1695, 17551], [10, 1894, 19939],
  ])('%i members -> %i / %i', (seats, month, year) => {
    expect(amountFor(LAUNCH_FORMULA, 'month', seats)).toBe(month);
    expect(amountFor(LAUNCH_FORMULA, 'year', seats)).toBe(year);
  });

  it('rejects sizes outside 5..10', () => {
    expect(() => assertSeats(4)).toThrow();
    expect(() => assertSeats(11)).toThrow();
    expect(() => assertSeats(5.5)).toThrow();
  });

  it('builds lookup keys', () => {
    expect(lookupKey('year', 7)).toBe('rootaroo_hh7_year');
  });
});

describe('getCatalog', () => {
  it('loads both intervals by lookup key (max 10 per call) and caches for 10 minutes', async () => {
    const cat = await getCatalog('test', 1_000);
    expect(cat.priceSet).toBe('2026-10');
    expect(cat.prices).toHaveLength(12);
    expect(stripe.prices.list).toHaveBeenCalledTimes(2);
    for (const call of stripe.prices.list.mock.calls) expect((call[0] as any).lookup_keys.length).toBeLessThanOrEqual(10);
    await getCatalog('test', 1_000 + 9 * 60_000);
    expect(stripe.prices.list).toHaveBeenCalledTimes(2);
    await getCatalog('test', 1_000 + 11 * 60_000);
    expect(stripe.prices.list).toHaveBeenCalledTimes(4);
  });

  it('busting clears the cache and publishes', async () => {
    await getCatalog('test');
    redisMock.status = 'ready';
    redisMock.publish.mockResolvedValue(1);
    await bustCatalogCache('test');
    expect(redisMock.publish).toHaveBeenCalledWith('billing:catalog:bust', 'test');
    await getCatalog('test');
    expect(stripe.prices.list).toHaveBeenCalledTimes(4);
    redisMock.status = 'end';
  });

  it('refuses an incomplete catalog with 503 CATALOG_UNAVAILABLE', async () => {
    stripe.prices.list.mockImplementation(() => listOf(catalogPrices().slice(0, 5)));
    await expect(getCatalog('test')).rejects.toMatchObject({ statusCode: 503, code: 'CATALOG_UNAVAILABLE' });
  });

  it('priceFor returns the matching price', async () => {
    const cat = await getCatalog('test');
    expect(priceFor(cat, 'year', 7)).toMatchObject({ amount: 12775, seats: 7, interval: 'year' });
  });
});

describe('findPriceInSet', () => {
  it('uses the catalog for the current set', async () => {
    const p = await findPriceInSet('test', '2026-10', 'month', 6);
    expect(p!.amount).toBe(1098);
  });

  it('finds an older set among all active prices (grandfathering)', async () => {
    const old = stripePrice({ id: 'price_old_6m', seats: 6, interval: 'month', priceSet: '2025-01', amount: 999, lookupKey: null });
    stripe.prices.list.mockImplementation((p: { lookup_keys?: string[] }) =>
      listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys!.includes(x.lookup_key!)) : [...catalogPrices(), old]));
    await expect(findPriceInSet('test', '2025-01', 'month', 6)).resolves.toMatchObject({ priceId: 'price_old_6m', amount: 999 });
    await expect(findPriceInSet('test', '2025-01', 'year', 6)).resolves.toBeNull();
  });
});

describe('toCatalogPrice', () => {
  it('rejects prices without valid metadata', () => {
    const bad = stripePrice();
    (bad as any).metadata = { seats: 'eleven' };
    expect(toCatalogPrice(bad)).toBeNull();
  });
});
