jest.mock('../../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { setupAssociations, BillingSubscription, BillingReconciliationItem, BillingTransaction } from '../../../../database/models';
import { resetDb, closeIntResources } from '../../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../../test/factories';
import { createSubscriptionRow } from '../../../../test/billing/rows';
import { verifiedPurchase } from '../../../../test/billing/iapFixtures';
import { getEntitlement } from '../../entitlement';
import { upsertStoreSubscription, recordStoreTransaction } from '../store';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('upsertStoreSubscription', () => {
  it('creates an active store subscription that grants entitlement through the shared path', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const res = await upsertStoreSubscription(verifiedPurchase({ householdId: household.id, seats: 7, productId: 'rootaroo.hh7.month' }), { purchasedByUserId: admin.id });
    expect(res.outcome).toBe('applied');
    expect(res.row).toMatchObject({ provider: 'apple', seats: 7, status: 'active', purchasedByUserId: admin.id, priceId: 'rootaroo.hh7.month' });
    const ent = await getEntitlement(household.id, { bypassCache: true });
    expect(ent).toMatchObject({ allowed: true, reason: 'active', seatsAllowed: 7 });
    expect(ent.subscription!.provider).toBe('apple');
  });

  it('livemode=false rows only count in test mode (sandbox stays out of live entitlement)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await upsertStoreSubscription(verifiedPurchase({ householdId: household.id, livemode: true }));
    // non-production NODE_ENV resolves every household to test mode, so a production-environment row grants nothing here
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(false);
  });

  it('updates in place by (provider, livemode, subscriptionId) and keeps the original purchaser', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const vp = verifiedPurchase({ householdId: household.id });
    await upsertStoreSubscription(vp, { purchasedByUserId: admin.id });
    const res = await upsertStoreSubscription({ ...vp, status: 'canceled', endedAt: new Date() });
    expect(res.row).toMatchObject({ status: 'canceled', purchasedByUserId: admin.id });
    expect(await BillingSubscription.count()).toBe(1);
  });

  it('past_due keeps the store grace expiry; recovery clears it', async () => {
    const { household } = await createHouseholdWithAdmin();
    const until = new Date(Math.floor((Date.now() + 5 * 86400_000) / 1000) * 1000);
    const vp = verifiedPurchase({ householdId: household.id, status: 'past_due', graceUntil: until });
    await upsertStoreSubscription(vp);
    expect(await getEntitlement(household.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'grace', graceUntil: until.toISOString() });
    const row = await upsertStoreSubscription({ ...vp, status: 'active', graceUntil: until });
    expect(row.row!.graceUntil).toBeNull();
  });

  it('skips a notification older than the watermark (out-of-order delivery)', async () => {
    const { household } = await createHouseholdWithAdmin();
    const vp = verifiedPurchase({ householdId: household.id });
    await upsertStoreSubscription(vp, { eventCreated: 2000 });
    const stale = await upsertStoreSubscription({ ...vp, status: 'canceled' }, { eventCreated: 1000 });
    expect(stale.outcome).toBe('stale');
    expect((await BillingSubscription.findOne())!.status).toBe('active');
    const fresh = await upsertStoreSubscription({ ...vp, status: 'canceled' }, { eventCreated: 3000 });
    expect(fresh.outcome).toBe('applied');
    expect(Number((await BillingSubscription.findOne())!.eventWatermark)).toBe(3000);
  });

  it('an untagged purchase with no known row is unmatched: review item, no row', async () => {
    const res = await upsertStoreSubscription(verifiedPurchase({ householdId: null }));
    expect(res).toEqual({ outcome: 'unmatched', row: null });
    expect(await BillingSubscription.count()).toBe(0);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_subscription', resolution: 'needs_review' } })).toBe(1);
  });

  it('an untagged update still applies to the household that already owns the row', async () => {
    const { household } = await createHouseholdWithAdmin();
    const vp = verifiedPurchase({ householdId: household.id });
    await upsertStoreSubscription(vp);
    const res = await upsertStoreSubscription({ ...vp, householdId: null, status: 'canceled' });
    expect(res.outcome).toBe('applied');
    expect(res.row!.householdId).toBe(household.id);
  });

  it('never moves a subscription to another household: review item, row untouched', async () => {
    const a = await createHouseholdWithAdmin();
    const b = await createHouseholdWithAdmin();
    const vp = verifiedPurchase({ householdId: a.household.id });
    await upsertStoreSubscription(vp);
    const res = await upsertStoreSubscription({ ...vp, householdId: b.household.id });
    expect(res.outcome).toBe('household_mismatch');
    expect((await BillingSubscription.findOne())!.householdId).toBe(a.household.id);
    expect(await BillingReconciliationItem.count({ where: { kind: 'store_household_mismatch' } })).toBe(1);
  });

  it('expectedHouseholdId (verify endpoint) rejects a purchase tagged for someone else', async () => {
    const a = await createHouseholdWithAdmin();
    const b = await createHouseholdWithAdmin();
    const res = await upsertStoreSubscription(verifiedPurchase({ householdId: a.household.id }), { expectedHouseholdId: b.household.id });
    expect(res.outcome).toBe('household_mismatch');
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('an unknown product raises unknown_price and keeps a safe default of 5 seats', async () => {
    const { household } = await createHouseholdWithAdmin();
    const res = await upsertStoreSubscription(verifiedPurchase({ householdId: household.id, productId: 'other.product', seats: null }));
    expect(res.row!.seats).toBe(5);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unknown_price' } })).toBe(1);
  });

  it('D5: a store subscription next to a Stripe one only raises a review item and cancels nothing', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_stripe_1' });
    await upsertStoreSubscription(verifiedPurchase({ householdId: household.id }));
    expect(await BillingReconciliationItem.count({ where: { kind: 'cross_provider_duplicate', resolution: 'needs_review' } })).toBe(1);
    expect((await BillingSubscription.findAll()).map((r) => r.status)).toEqual(['active', 'active']);
  });
});

describe('recordStoreTransaction', () => {
  it('writes a matched ledger row once per store object id and updates it on replay', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const { row } = await upsertStoreSubscription(verifiedPurchase({ householdId: household.id }), { purchasedByUserId: admin.id });
    const base = { row: row!, type: 'payment' as const, objectId: '2000000999', amount: 899, currency: 'USD', at: new Date(), status: 'paid', reason: 'renewal', eventId: 'n1' };
    await recordStoreTransaction(base);
    await recordStoreTransaction({ ...base, amount: 999 });
    const rows = await BillingTransaction.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'apple', type: 'payment', amount: 999, currency: 'usd', matchStatus: 'matched', householdId: household.id, userId: admin.id });
  });

  it('falls back to the list price when the store reports none', async () => {
    const { household } = await createHouseholdWithAdmin();
    const { row } = await upsertStoreSubscription(verifiedPurchase({ householdId: household.id, seats: 6, productId: 'rootaroo.hh6.month' }));
    await recordStoreTransaction({ row: row!, type: 'payment', objectId: 'tx1', amount: null, currency: null, at: new Date(), status: 'paid', reason: 'purchase', eventId: null });
    expect((await BillingTransaction.findOne())!.amount).toBe(1098);
  });
});
