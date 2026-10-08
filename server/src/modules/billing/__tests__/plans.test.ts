jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end' } }));

import { getPlansForMode } from '../plans';
import { clearLocalCatalogCache } from '../catalog';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices } from '../../../test/billing/fixtures';

describe('getPlansForMode', () => {
  it('returns the full matrix with price ids and amounts', async () => {
    clearLocalCatalogCache();
    const s = installStripeMock('test');
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    const plans = await getPlansForMode('test');
    expect(plans).toMatchObject({ mode: 'test', priceSet: '2026-10', currency: 'usd', seatsIncluded: 5, seatsMax: 10 });
    expect(plans.matrix.month['5']).toEqual({ priceId: 'price_202610_5_month', amount: 899 });
    expect(plans.matrix.year['10']).toEqual({ priceId: 'price_202610_10_year', amount: 19939 });
    expect(Object.keys(plans.matrix.month)).toEqual(['5', '6', '7', '8', '9', '10']);
  });
});
