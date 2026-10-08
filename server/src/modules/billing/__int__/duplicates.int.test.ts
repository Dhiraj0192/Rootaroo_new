jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { setupAssociations, BillingSubscription, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { resolveDuplicates } from '../duplicates';
import { alertStaff, notifyHouseholdAdmins } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('resolveDuplicates (D3)', () => {
  it('keeps the healthy subscription, cancels and refunds the other, raises review', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_old', status: 'active' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_new', status: 'active' });
    const inv = stripeInvoice({ id: 'in_new', status: 'paid', amountPaid: 899 });
    const canceledIds = new Set<string>();
    s.subscriptions.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_old' ? stripeSubscription({ id, created: 100, householdId: household.id }) : stripeSubscription({ id, created: 200, householdId: household.id, latestInvoice: inv, status: canceledIds.has(id) ? 'canceled' : 'active' }));
    s.subscriptions.cancel.mockImplementation(async (id: string) => { canceledIds.add(id); return { ...stripeSubscription({ id, status: 'canceled' }), canceled_at: 300, ended_at: 300 }; });
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_new' } } }]));
    s.refunds.create.mockResolvedValue({ id: 're_1' });

    await expect(resolveDuplicates(household.id, 'test')).resolves.toEqual({ kept: 'sub_old', canceled: ['sub_new'] });
    expect(s.subscriptions.cancel).toHaveBeenCalledWith('sub_new', { prorate: false }, { idempotencyKey: 'dupcancel:sub_new' });
    expect(s.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_new', reason: 'duplicate' }), { idempotencyKey: 'dup:sub_new' });
    const cancelledRow = (await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_new' } }))!;
    expect(cancelledRow.status).toBe('canceled');
    expect(cancelledRow.lastSyncedAt).not.toBeNull(); // written by upsertSubscription, not a direct update (finding 7)
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_refunded', expect.any(String), expect.stringContaining('refunded'), {}, { email: true });
    expect(await BillingReconciliationItem.count({ where: { kind: 'duplicate_subscription', resolution: 'needs_review' } })).toBe(1);
    expect(alertStaff).toHaveBeenCalled();
    expect(notifyHouseholdAdmins).toHaveBeenCalled();
  });

  it('cross-provider duplicates only raise a review item and tell the admin (D5)', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_1' });
    await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000123' });
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
    expect(s.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await BillingReconciliationItem.count({ where: { kind: 'cross_provider_duplicate' } })).toBe(1);
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_store', expect.any(String), expect.any(String), {}, { email: true });
  });

  it('does nothing for a single subscription or when Stripe shows only one allowed', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_a' });
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_b' });
    s.subscriptions.retrieve.mockImplementation(async (id: string) => stripeSubscription({ id, status: id === 'sub_b' ? 'canceled' : 'active' }));
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
  });

  async function twoSubs(opts: { oldStatus?: 'active' | 'past_due'; oldInvoicePaidAt: number }) {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_old', status: opts.oldStatus ?? 'past_due' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_new', status: 'active' });
    const oldInv = stripeInvoice({ id: 'in_old', status: 'paid', amountPaid: 899, paidAt: opts.oldInvoicePaidAt });
    const canceledIds = new Set<string>();
    const s = installStripeMock('test');
    s.subscriptions.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_new'
        ? stripeSubscription({ id, created: 200, householdId: household.id })
        : stripeSubscription({ id, created: 100, householdId: household.id, status: canceledIds.has(id) ? 'canceled' : (opts.oldStatus ?? 'past_due'), latestInvoice: oldInv }));
    s.subscriptions.cancel.mockImplementation(async (id: string) => { canceledIds.add(id); return { ...stripeSubscription({ id, status: 'canceled' }), canceled_at: 300, ended_at: 300 }; });
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_old' } } }]));
    s.refunds.create.mockResolvedValue({ id: 're_1' });
    return { s, household };
  }

  it('does not refund an invoice that was paid before the keeper existed (finding 6)', async () => {
    const { s, household } = await twoSubs({ oldInvoicePaidAt: 150 }); // keeper (sub_new) created at 200
    await expect(resolveDuplicates(household.id, 'test')).resolves.toEqual({ kept: 'sub_new', canceled: ['sub_old'] });
    expect(s.refunds.create).not.toHaveBeenCalled();
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_cancelled', expect.any(String), expect.stringMatching(/no refund/i), {}, { email: true });
  });

  it('refunds an invoice paid inside the overlap window', async () => {
    const { s, household } = await twoSubs({ oldInvoicePaidAt: 250 });
    await resolveDuplicates(household.id, 'test');
    expect(s.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_old' }), { idempotencyKey: 'dup:sub_old' });
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_refunded', expect.any(String), expect.stringContaining('refunded'), {}, { email: true });
  });

  it('tells the admin when the refund failed and raises a review item (finding 6)', async () => {
    const { s, household } = await twoSubs({ oldInvoicePaidAt: 250 });
    s.refunds.create.mockRejectedValue(new Error('charge_already_refunded'));
    await resolveDuplicates(household.id, 'test');
    expect(await BillingReconciliationItem.count({ where: { kind: 'duplicate_refund_failed', resolution: 'needs_review' } })).toBe(1);
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_refund_failed', expect.any(String), expect.stringMatching(/could not refund/i), {}, { email: true });
  });

  it('concurrent resolutions cancel once and send one email (finding 7)', async () => {
    const { s, household } = await twoSubs({ oldInvoicePaidAt: 250 });
    (notifyHouseholdAdmins as jest.Mock).mockClear();
    const results = await Promise.all([resolveDuplicates(household.id, 'test'), resolveDuplicates(household.id, 'test')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(s.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(s.refunds.create).toHaveBeenCalledTimes(1);
    expect((notifyHouseholdAdmins as jest.Mock).mock.calls.filter((c) => String(c[1]).startsWith('billing_duplicate_'))).toHaveLength(1);
  });

  it('cancelling does not recurse back into duplicate resolution', async () => {
    const { s, household } = await twoSubs({ oldInvoicePaidAt: 250 });
    await resolveDuplicates(household.id, 'test');
    expect(s.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(await BillingReconciliationItem.count({ where: { kind: 'duplicate_subscription' } })).toBe(1);
  });
});
