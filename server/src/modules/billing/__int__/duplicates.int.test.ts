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
    s.subscriptions.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_old' ? stripeSubscription({ id, created: 100 }) : stripeSubscription({ id, created: 200, latestInvoice: inv }));
    s.subscriptions.cancel.mockResolvedValue({ ...stripeSubscription({ id: 'sub_new', status: 'canceled' }), canceled_at: 300, ended_at: 300 });
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_new' } } }]));
    s.refunds.create.mockResolvedValue({ id: 're_1' });

    await expect(resolveDuplicates(household.id, 'test')).resolves.toEqual({ kept: 'sub_old', canceled: ['sub_new'] });
    expect(s.subscriptions.cancel).toHaveBeenCalledWith('sub_new', { prorate: false }, { idempotencyKey: 'dupcancel:sub_new' });
    expect(s.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_new', reason: 'duplicate' }), { idempotencyKey: 'dup:sub_new' });
    expect((await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_new' } }))!.status).toBe('canceled');
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
});
