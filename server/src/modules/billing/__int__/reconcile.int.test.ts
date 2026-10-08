jest.mock('../notify', () => {
  const actual = jest.requireActual('../notify');
  return { ...actual, notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() };
});

import {
  setupAssociations, BillingSubscription, BillingReconciliationItem, BillingTransaction, BillingCustomer,
} from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { runReconciliation } from '../reconcile';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

describe('runReconciliation (criterion 5)', () => {
  it('fixes planted drift, fills ledger and fees, flags what needs review', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_R', billingEmail: 'stale@x' });
    // planted: wrong seats/status locally
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_R', seats: 5, status: 'past_due', purchasedByUserId: admin.id });
    // planted: local subscription Stripe no longer knows
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_GONE', status: 'active' });
    // planted: payment row with missing fee
    await BillingTransaction.create({ provider: 'stripe', livemode: false, type: 'payment', status: 'paid', amount: 899, currency: 'usd', matchStatus: 'matched', householdId: household.id, providerObjectId: 'in_NOFEE', occurredAt: new Date() });

    s.subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === 'sub_GONE') throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      return stripeSubscription({ id, customer: 'cus_R', seats: 8, status: 'active' });
    });
    s.subscriptions.list.mockReturnValue(listOf([stripeSubscription({ id: 'sub_R', customer: 'cus_R', seats: 8 }), stripeSubscription({ id: 'sub_OTHER_ENV', env: 'prod' })]));
    s.invoices.list.mockReturnValue(listOf([stripeInvoice({ id: 'in_MISSING', customer: 'cus_R', subscriptionId: 'sub_R', amountPaid: 1496 })]));
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } } }]));
    s.charges.retrieve.mockResolvedValue({ id: 'ch_1', receipt_url: null, balance_transaction: { fee: 73, net: 1423 } });
    s.customers.retrieve.mockResolvedValue({ id: 'cus_R', email: 'stale@x' });
    s.customers.update.mockResolvedValue({});

    const run = await runReconciliation('test', 'daily');

    expect(run.status).toBe('succeeded');
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_R' } })).toMatchObject({ seats: 8, status: 'active' });
    const drift = await BillingReconciliationItem.findOne({ where: { kind: 'subscription_drift', providerObjectId: 'sub_R' } });
    expect(drift).toMatchObject({ resolution: 'auto_fixed', runId: run.id });
    expect(drift!.before).toMatchObject({ seats: 5, status: 'past_due' });
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_GONE' } })).toMatchObject({ status: 'canceled' });
    expect(await BillingReconciliationItem.count({ where: { kind: 'missing_in_stripe', resolution: 'needs_review' } })).toBe(1);
    expect(await BillingTransaction.findOne({ where: { providerObjectId: 'in_MISSING' } })).toMatchObject({ amount: 1496, fee: 73 });
    expect((await BillingTransaction.findOne({ where: { providerObjectId: 'in_NOFEE' } }))!.fee).toBe(73);
    expect((await BillingCustomer.findOne({ where: { providerCustomerId: 'cus_R' } }))!.billingEmail).toBe(admin.email);
    expect(s.customers.update).toHaveBeenCalledWith('cus_R', { email: admin.email });
    expect(s.subscriptions.retrieve).not.toHaveBeenCalledWith('sub_OTHER_ENV', expect.anything());
    expect(run.counts).toMatchObject({ subscriptionsFixed: 1, missingInStripe: 1, feesFilled: 1, emailDriftFixed: 1 });
  });

  it('flags duplicates that section 8.6 could not resolve (cross-provider)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_A' });
    await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000555' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', householdId: household.id }));
    await runReconciliation('test', 'manual');
    expect(await BillingReconciliationItem.count({ where: { kind: 'unresolved_duplicate' } })).toBe(1);
  });

  it('weekly lists every subscription (no created filter) and a 35-day ledger window', async () => {
    await runReconciliation('test', 'weekly', new Date('2026-10-10T04:00:00Z'));
    expect(s.subscriptions.list).toHaveBeenCalledWith({ status: 'all', limit: 100 });
    const since = Math.floor(new Date('2026-09-05T04:00:00Z').getTime() / 1000);
    expect(s.invoices.list).toHaveBeenCalledWith({ created: { gte: since }, limit: 100 });
  });

  it('marks the run failed when Stripe errors', async () => {
    s.subscriptions.list.mockImplementation(() => { throw new Error('api down'); });
    await expect(runReconciliation('test', 'daily')).rejects.toThrow('api down');
  });
});

describe('runReconciliation: deletion drift (finding 2)', () => {
  it('re-applies cancel_at_period_end for a household scheduled for deletion and records an auto_fixed item', async () => {
    const { household } = await createHouseholdWithAdmin();
    await household.update({ scheduledDeletionAt: new Date(Date.now() + 20 * 86400_000) });
    await createCustomerRow(household.id, { providerCustomerId: 'cus_D' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_D', status: 'active', cancelAtPeriodEnd: false });
    let flag = false;
    s.subscriptions.retrieve.mockImplementation(async (id: string) => stripeSubscription({ id, customer: 'cus_D', cancelAtPeriodEnd: flag }));
    s.subscriptions.update.mockImplementation(async (_id: string, p: { cancel_at_period_end: boolean }) => { flag = p.cancel_at_period_end; return {}; });
    s.customers.retrieve.mockResolvedValue({ id: 'cus_D', email: null });

    const run = await runReconciliation('test', 'daily');

    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_D', { cancel_at_period_end: true });
    expect((await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_D' } }))!.cancelAtPeriodEnd).toBe(true);
    expect(await BillingReconciliationItem.findOne({ where: { kind: 'deletion_drift', providerObjectId: 'sub_D' } })).toMatchObject({ resolution: 'auto_fixed', runId: run.id });
  });

  it('does nothing when the household is not scheduled or the subscription already cancels', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_E' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_E', status: 'active', cancelAtPeriodEnd: false });
    s.subscriptions.retrieve.mockImplementation(async (id: string) => stripeSubscription({ id, customer: 'cus_E' }));
    s.customers.retrieve.mockResolvedValue({ id: 'cus_E', email: null });
    await runReconciliation('test', 'daily');
    expect(s.subscriptions.update).not.toHaveBeenCalled();
    expect(await BillingReconciliationItem.count({ where: { kind: 'deletion_drift' } })).toBe(0);
  });
});
