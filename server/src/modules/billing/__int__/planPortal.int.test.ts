jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingPriceNotice } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice, stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { __clearPortalCacheForTests } from '../portal';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  __clearPortalCacheForTests();
  s = installStripeMock('test');
  const old6m = stripePrice({ id: 'price_old_6m', seats: 6, interval: 'month', priceSet: '2025-01', amount: 999, lookupKey: null });
  const all = [...catalogPrices(), old6m, ...catalogPrices('2027-01').map((p) => ({ ...p, lookup_key: null }))];
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
  s.billingPortal.configurations.list.mockReturnValue(listOf([{ id: 'bpc_1', metadata: { rootaroo_portal: 'v1' } }]));
  s.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
});
afterAll(() => closeIntResources());

async function subscribed(overrides: Record<string, unknown> = {}) {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
  const row = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_1', ...overrides });
  s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1', itemId: 'si_1', seats: row.seats, interval: row.interval }));
  s.subscriptions.update.mockImplementation(async () => stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));
  return { household, admin, row };
}
const plan = (user: any, body: object) => request(app).post('/api/v1/billing/plan').set(authHeaderFor(user)).send(body);

describe('POST /billing/portal', () => {
  it('opens the tagged portal configuration for an admin', async () => {
    const { admin } = await subscribed();
    const res = await request(app).post('/api/v1/billing/portal').set(authHeaderFor(admin));
    expect(res.body.data.url).toBe('https://billing.stripe.com/p/session/x');
    expect(s.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://api.example.test/api/v1/billing/return/portal', configuration: 'bpc_1' });
  });

  it('403 for members, 409 without a customer', async () => {
    const { household } = await subscribed();
    expect((await request(app).post('/api/v1/billing/portal').set(authHeaderFor(await addMember(household.id)))).status).toBe(403);
    const other = await createHouseholdWithAdmin();
    expect((await request(app).post('/api/v1/billing/portal').set(authHeaderFor(other.admin))).body.code).toBe('NO_ACTIVE_SUBSCRIPTION');
  });
});

describe('POST /billing/plan', () => {
  it('same interval: swaps the item price with always_invoice + pending_if_incomplete', async () => {
    const { admin } = await subscribed();
    const res = await plan(admin, { interval: 'month', seats: 7 });
    expect(res.status).toBe(200);
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_1', price: 'price_202610_7_month' }], payment_behavior: 'pending_if_incomplete',
      proration_behavior: 'always_invoice', expand: ['latest_invoice'],
    });
  });

  it('interval change: create_prorations and billing_cycle_anchor now', async () => {
    const { admin } = await subscribed();
    await plan(admin, { interval: 'year', seats: 5 });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      items: [{ id: 'si_1', price: 'price_202610_5_year' }], proration_behavior: 'create_prorations', billing_cycle_anchor: { type: 'now' }, payment_behavior: 'pending_if_incomplete',
    }));
  });

  it('no change -> 200 without calling Stripe', async () => {
    const { admin } = await subscribed();
    const res = await plan(admin, { interval: 'month', seats: 5 });
    expect(res.body.data.changed).toBe(false);
    expect(s.subscriptions.update).not.toHaveBeenCalled();
  });

  it('409 SEATS_BELOW_MEMBERS (L5)', async () => {
    const { household, admin } = await subscribed({ seats: 7 });
    for (let i = 0; i < 6; i++) await addMember(household.id);
    expect((await plan(admin, { interval: 'month', seats: 6 })).body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 7 });
  });

  it('grandfathered subscribers stay on their price set (§6.5)', async () => {
    const { admin } = await subscribed({ priceSet: '2025-01', seats: 5 });
    await plan(admin, { interval: 'month', seats: 6 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_old_6m');
  });

  it('falls back to the current lookup key when the old set lacks that size', async () => {
    const { admin } = await subscribed({ priceSet: '2025-01', seats: 5 });
    await plan(admin, { interval: 'month', seats: 8 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_202610_8_month');
  });

  it('a scheduled price notice re-targets the to-set (§6.4)', async () => {
    const { admin, row } = await subscribed();
    await BillingPriceNotice.create({ subscriptionId: row.id, fromPriceId: 'price_202610_5_month', toPriceSet: '2027-01', noticeSentAt: new Date(), applyAfter: new Date(Date.now() + 30 * 86400_000) });
    await plan(admin, { interval: 'month', seats: 6 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_202701_6_month');
  });

  it('a failed upgrade returns pendingUpdate and the hosted invoice (T8)', async () => {
    const { admin } = await subscribed();
    s.subscriptions.update.mockResolvedValue(stripeSubscription({
      id: 'sub_1', customer: 'cus_1', pendingUpdate: { expires_at: 1 }, latestInvoice: stripeInvoice({ status: 'open', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' }),
    }));
    const res = await plan(admin, { interval: 'month', seats: 9 });
    expect(res.body.data).toMatchObject({ changed: true, pendingUpdate: true, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
  });

  it('403 for non-admins (B6), 409 for store subscriptions and past_due', async () => {
    const { household } = await subscribed();
    expect((await plan(await addMember(household.id), { interval: 'month', seats: 6 })).status).toBe(403);
    const store = await createHouseholdWithAdmin();
    await createSubscriptionRow(store.household.id, { provider: 'apple', providerSubscriptionId: '2000000999' });
    expect((await plan(store.admin, { interval: 'month', seats: 6 })).body.code).toBe('PURCHASE_METHOD_MISMATCH');
    const pd = await createHouseholdWithAdmin();
    await createCustomerRow(pd.household.id, { providerCustomerId: 'cus_pd' });
    await createSubscriptionRow(pd.household.id, { status: 'past_due', graceUntil: new Date(Date.now() + 1e6) });
    expect((await plan(pd.admin, { interval: 'month', seats: 6 })).body.code).toBe('PAYMENT_ISSUE');
  });
});
