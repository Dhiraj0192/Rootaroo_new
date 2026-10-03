jest.mock('../notify', () => {
  const actual = jest.requireActual('../notify');
  return { ...actual, notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() };
});

import { setupAssociations, BillingSubscription, BillingTransaction, BillingCustomer, HouseholdMember, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription } from '../../../test/billing/fixtures';
import { onPurchaserDeleted, onHouseholdDeletionScheduled, onHouseholdDeletionCancelled, onHouseholdPurged, syncBillingEmail } from '../deletion';
import { notifyHouseholdAdmins } from '../notify';
import { ANONYMIZED_EMAIL } from '../ledger';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function paid() {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_Z' });
  const sub = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_Z', purchasedByUserId: admin.id });
  s.subscriptions.update.mockResolvedValue({});
  s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', cancelAtPeriodEnd: true }));
  s.customers.update.mockResolvedValue({});
  return { household, admin, sub };
}

describe('purchaser deletion (L6)', () => {
  it('cancels at period end, clears purchaser, anonymises ledger, notifies and moves the email', async () => {
    const { household, admin } = await paid();
    const newAdmin = await addMember(household.id);
    await HouseholdMember.update({ role: 'admin' }, { where: { userId: newAdmin.id } });
    await HouseholdMember.update({ role: 'member' }, { where: { userId: admin.id } });
    await BillingTransaction.create({ provider: 'stripe', livemode: false, type: 'payment', status: 'paid', amount: 899, currency: 'usd', matchStatus: 'matched', householdId: household.id, userId: admin.id, payerEmailSnapshot: admin.email, providerObjectId: 'in_Z', occurredAt: new Date() });

    await onPurchaserDeleted(admin.id);

    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_Z', { cancel_at_period_end: true }, { idempotencyKey: 'purchaser-deleted:sub_Z' });
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_Z' } })).toMatchObject({ purchasedByUserId: null, cancelAtPeriodEnd: true });
    expect(await BillingTransaction.findOne({ where: { providerObjectId: 'in_Z' } })).toMatchObject({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL });
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_purchaser_deleted', expect.any(String), expect.stringContaining('Resubscribe before'), expect.anything(), { email: true, excludeUserId: admin.id });
    expect(s.customers.update).toHaveBeenCalledWith('cus_Z', { email: newAdmin.email });
  });
});

describe('household deletion (L7, §8.7)', () => {
  it('scheduling sets cancel_at_period_end, cancelling reverses it', async () => {
    const { household } = await paid();
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', cancelAtPeriodEnd: true }));
    await onHouseholdDeletionScheduled(household.id);
    expect(s.subscriptions.update).toHaveBeenLastCalledWith('sub_Z', { cancel_at_period_end: true }, expect.anything());
    // the upsert above stored cancelAtPeriodEnd = true, so cancelling is a real change
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', cancelAtPeriodEnd: false }));
    await onHouseholdDeletionCancelled(household.id);
    expect(s.subscriptions.update).toHaveBeenLastCalledWith('sub_Z', { cancel_at_period_end: false }, expect.anything());
  });

  it('final purge cancels an allowed subscription immediately and audits it', async () => {
    const { household } = await paid();
    s.subscriptions.cancel.mockResolvedValue({});
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', status: 'canceled' }));
    await onHouseholdPurged(household.id);
    expect(s.subscriptions.cancel).toHaveBeenCalledWith('sub_Z', { prorate: false }, { idempotencyKey: `purge:${household.id}:sub_Z` });
    expect(await AdminAuditLog.count({ where: { path: `purge:household:${household.id}` } })).toBe(1);
  });
});

describe('admin transfer (L8)', () => {
  it('updates billing_email in the DB first, then Stripe', async () => {
    const { household } = await paid();
    const other = await addMember(household.id);
    await HouseholdMember.update({ role: 'member' }, { where: { householdId: household.id, role: 'admin' } });
    await HouseholdMember.update({ role: 'admin' }, { where: { userId: other.id } });
    await syncBillingEmail(household.id);
    expect((await BillingCustomer.findOne({ where: { providerCustomerId: 'cus_Z' } }))!.billingEmail).toBe(other.email);
    expect(s.customers.update).toHaveBeenCalledWith('cus_Z', { email: other.email });
  });
});
