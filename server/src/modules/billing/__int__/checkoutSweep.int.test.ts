jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { v4 as uuidv4 } from 'uuid';
import { setupAssociations, BillingCheckoutSession, BillingSubscription } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { sweepCheckouts } from '../checkoutSweep';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function row(householdId: string, userId: string, o: Record<string, unknown>) {
  return BillingCheckoutSession.create({
    id: uuidv4(), householdId, livemode: false, createdByUserId: userId, interval: 'month', seats: 5,
    status: 'open', url: 'u', expiresAt: new Date(Date.now() + 1e6), ...o,
  });
}

describe('sweepCheckouts', () => {
  it('syncs completed sessions, marks expired, fails orphaned creating rows, ignores fresh rows', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
    const old = new Date(Date.now() - 10 * 60_000);
    const done = await row(household.id, admin.id, { providerSessionId: 'cs_test_done', createdAt: old });
    const gone = await row(household.id, admin.id, { providerSessionId: 'cs_test_gone', createdAt: old });
    const orphan = await row(household.id, admin.id, { status: 'creating', providerSessionId: null, createdAt: old });
    const fresh = await row(household.id, admin.id, { providerSessionId: 'cs_test_fresh' });
    s.checkout.sessions.retrieve.mockImplementation(async (id: string) =>
      id === 'cs_test_done'
        ? stripeCheckoutSession({ id, status: 'complete', subscription: 'sub_1', customer: 'cus_1' })
        : stripeCheckoutSession({ id, status: 'expired' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));

    expect(await sweepCheckouts('test')).toEqual({ completed: 1, expired: 1, failed: 1 });
    expect((await done.reload()).status).toBe('complete');
    expect((await gone.reload()).status).toBe('expired');
    expect((await orphan.reload()).status).toBe('failed');
    expect((await fresh.reload()).status).toBe('open');
    expect(await BillingSubscription.count({ where: { providerSubscriptionId: 'sub_1' } })).toBe(1);
  });
});
