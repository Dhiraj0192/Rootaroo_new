jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn(), getAdminRecipients: jest.fn(async () => []) }));

import { setupAssociations, BillingPriceNotice } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { scheduleMigration, applyDueNotices } from '../priceNotices';
import { notifyHouseholdAdmins } from '../notify';

let s: StripeMock;
const day = 86400_000;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  s = installStripeMock('test');
  const next = catalogPrices('2027-01', { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 }).map((p) => ({ ...p, lookup_key: null }));
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys.includes(x.lookup_key)) : [...catalogPrices(), ...next]));
});
afterAll(() => closeIntResources());

describe('price migration', () => {
  it('schedules notices with old/new price and renewal date, idempotently', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_P', priceSet: '2026-10', currentPeriodEnd: new Date(Date.now() + 20 * day) });
    expect(await scheduleMigration('test', '2026-10', '2027-01', 30)).toEqual({ scheduled: 1, skipped: 0 });
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_price_change', expect.any(String), expect.stringMatching(/\$8\.99 to \$9\.99 per month/), expect.anything(), { email: true });
    expect(await scheduleMigration('test', '2026-10', '2027-01', 30)).toEqual({ scheduled: 0, skipped: 0 });
    expect(await BillingPriceNotice.count()).toBe(1);
  });

  it('applies due notices with proration none for the same seats and interval', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_P' });
    const row = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_P', seats: 6, interval: 'month', currentPeriodEnd: new Date(Date.now() + 10 * day) });
    const notice = await BillingPriceNotice.create({ subscriptionId: row.id, fromPriceId: 'price_202610_6_month', toPriceSet: '2027-01', noticeSentAt: new Date(Date.now() - 31 * day), applyAfter: new Date(Date.now() - day) });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_P', customer: 'cus_P', seats: 6, itemId: 'si_P' }));
    s.subscriptions.update.mockResolvedValue({});
    expect(await applyDueNotices('test')).toMatchObject({ applied: 1 });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_P', { items: [{ id: 'si_P', price: 'price_202701_6_month' }], proration_behavior: 'none' }, { idempotencyKey: `pricenotice:${notice.id}` });
    expect((await notice.reload()).status).toBe('applied');
  });

  it('waits inside the 48 h window and skips canceled subscriptions', async () => {
    const { household } = await createHouseholdWithAdmin();
    const soon = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_S', currentPeriodEnd: new Date(Date.now() + 24 * 3600_000) });
    const gone = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_C', status: 'canceled' });
    for (const r of [soon, gone]) {
      await BillingPriceNotice.create({ subscriptionId: r.id, fromPriceId: 'x', toPriceSet: '2027-01', noticeSentAt: new Date(), applyAfter: new Date(Date.now() - day) });
    }
    expect(await applyDueNotices('test')).toMatchObject({ applied: 0, waiting: 1, skipped: 1 });
  });
});
