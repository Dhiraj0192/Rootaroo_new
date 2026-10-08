jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { setupAssociations, BillingSubscription, BillingReconciliationItem, BillingCustomer, Household } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { upsertSubscription } from '../sync';
import { getEntitlement } from '../entitlement';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

describe('upsertSubscription', () => {
  it('creates the row via billing_customers, sets purchaser on insert only, unlocks', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_A' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', customer: 'cus_A', seats: 6, purchasedByUserId: admin.id }));
    const row = await upsertSubscription('sub_A', 'test', { eventCreated: 50 });
    expect(row).toMatchObject({ householdId: household.id, seats: 6, status: 'active', purchasedByUserId: admin.id, eventWatermark: 50 });
    expect(s.subscriptions.retrieve).toHaveBeenCalledWith('sub_A', { expand: ['items.data.price', 'latest_invoice'] });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(true);

    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', customer: 'cus_A', seats: 6, purchasedByUserId: 'someone-else' }));
    const again = await upsertSubscription('sub_A', 'test', { eventCreated: 40 });
    expect(again!.purchasedByUserId).toBe(admin.id);
    expect(again!.eventWatermark).toBe(50);
  });

  it('recovers the household from metadata when the customer row is missing, and recreates it', async () => {
    const { household } = await createHouseholdWithAdmin();
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_M', customer: 'cus_M', householdId: household.id }));
    expect((await upsertSubscription('sub_M', 'test'))!.householdId).toBe(household.id);
    expect(await BillingCustomer.count({ where: { providerCustomerId: 'cus_M' } })).toBe(1);
  });

  it('unmatched subscription: review item, no row', async () => {
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_X', customer: 'cus_X' }));
    expect(await upsertSubscription('sub_X', 'test')).toBeNull();
    expect(await BillingSubscription.count()).toBe(0);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_subscription' } })).toBe(1);
  });

  it('ignores another environment (env tag) and never writes', async () => {
    const { household } = await createHouseholdWithAdmin();
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_E', householdId: household.id, env: 'staging' }));
    expect(await upsertSubscription('sub_E', 'test')).toBeNull();
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('refuses a livemode mismatch (B3)', async () => {
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_L', livemode: true }));
    await expect(upsertSubscription('sub_L', 'test')).rejects.toThrow(/livemode/);
  });

  it('computes grace on past_due and clears it on recovery', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_G' });
    const now = Math.floor(Date.now() / 1000);
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_G', customer: 'cus_G', status: 'past_due', latestInvoice: stripeInvoice({ status: 'open', finalizedAt: now }) }));
    const pd = await upsertSubscription('sub_G', 'test');
    expect(pd!.graceUntil!.getTime()).toBe((now + 7 * 86400) * 1000);
    expect(await getEntitlement(household.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'grace' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_G', customer: 'cus_G', status: 'active' }));
    expect((await upsertSubscription('sub_G', 'test'))!.graceUntil).toBeNull();
  });

  it('T5/T1: out-of-order and concurrent calls converge on the fresh Stripe state', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T', customer: 'cus_T', seats: 8, cancelAtPeriodEnd: true }));
    await Promise.all([upsertSubscription('sub_T', 'test', { eventCreated: 20 }), upsertSubscription('sub_T', 'test', { eventCreated: 10 })]);
    const rows = await BillingSubscription.findAll({ where: { providerSubscriptionId: 'sub_T' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seats: 8, cancelAtPeriodEnd: true, eventWatermark: 20 });
  });

  it('still links late events for a soft-deleted household (§8.7)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_D' });
    await Household.destroy({ where: { id: household.id } });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_D', customer: 'cus_D', status: 'canceled' }));
    expect((await upsertSubscription('sub_D', 'test'))!.householdId).toBe(household.id);
  });
});
