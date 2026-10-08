jest.mock('../sync', () => ({ upsertSubscription: jest.fn(), idOf: (x: any) => (x ? (typeof x === 'string' ? x : x.id) : null) }));
jest.mock('../ledger', () => ({
  recordInvoice: jest.fn(), recordRefund: jest.fn(), recordDispute: jest.fn(), linkInvoice: jest.fn(),
  invoiceSubscriptionId: (inv: any) => inv.parent?.subscription_details?.subscription ?? null,
}));
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));
jest.mock('../review', () => ({ raiseReviewItem: jest.fn() }));
jest.mock('../../../database/models', () => ({
  BillingCheckoutSession: { update: jest.fn() }, BillingCustomer: { update: jest.fn() }, BillingSubscription: { findOne: jest.fn() },
}));

import * as models from '../../../database/models';
import { upsertSubscription } from '../sync';
import { recordInvoice, recordRefund, recordDispute, linkInvoice } from '../ledger';
import { notifyHouseholdAdmins, alertStaff } from '../notify';
import { raiseReviewItem } from '../review';
import { dispatchEvent, envOfEventObject } from '../handlers';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { stripeEvent, stripeCheckoutSession, stripeSubscription, stripeInvoice, stripeRefund, stripeDispute } from '../../../test/billing/fixtures';

beforeEach(() => { jest.clearAllMocks(); installStripeMock('test'); });

describe('dispatchEvent (§8.5)', () => {
  it('checkout completed/async events mark the row complete and upsert', async () => {
    for (const t of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed']) {
      await dispatchEvent(stripeEvent(t, stripeCheckoutSession({ id: 'cs_test_1', status: 'complete', subscription: 'sub_1' }), { created: 77 }), 'test');
    }
    expect(models.BillingCheckoutSession.update).toHaveBeenCalledWith({ status: 'complete' }, { where: { providerSessionId: 'cs_test_1' } });
    expect(upsertSubscription).toHaveBeenCalledWith('sub_1', 'test', { eventCreated: 77 });
  });

  it('checkout expired marks the row expired', async () => {
    await dispatchEvent(stripeEvent('checkout.session.expired', stripeCheckoutSession({ id: 'cs_test_2', status: 'expired' })), 'test');
    expect(models.BillingCheckoutSession.update).toHaveBeenCalledWith({ status: 'expired' }, expect.objectContaining({ where: expect.objectContaining({ providerSessionId: 'cs_test_2' }) }));
  });

  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.pending_update_applied'])('%s upserts', async (t) => {
    await dispatchEvent(stripeEvent(t, stripeSubscription({ id: 'sub_9' })), 'test');
    expect(upsertSubscription).toHaveBeenCalledWith('sub_9', 'test', expect.anything());
  });

  it('pending_update_expired upserts and notifies the admin (T8)', async () => {
    (upsertSubscription as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('customer.subscription.pending_update_expired', stripeSubscription({ id: 'sub_9' })), 'test');
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith('h1', 'billing_plan_change_failed', expect.any(String), expect.any(String), expect.anything());
  });

  it('invoice.paid records a payment then upserts', async () => {
    await dispatchEvent(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_1', subscriptionId: 'sub_1' }), { id: 'evt_p' }), 'test');
    expect(recordInvoice).toHaveBeenCalledWith(expect.objectContaining({ id: 'in_1' }), 'test', 'payment', 'evt_p');
    expect(upsertSubscription).toHaveBeenCalledWith('sub_1', 'test', expect.anything());
  });

  it('invoice.paid and invoice.payment_failed upsert the subscription BEFORE recording the invoice (finding 3)', async () => {
    (recordInvoice as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_1', subscriptionId: 'sub_1' })), 'test');
    await dispatchEvent(stripeEvent('invoice.payment_failed', stripeInvoice({ id: 'in_2', subscriptionId: 'sub_1', status: 'open' })), 'test');
    const ups = (upsertSubscription as jest.Mock).mock.invocationCallOrder;
    const recs = (recordInvoice as jest.Mock).mock.invocationCallOrder;
    expect(ups).toHaveLength(2);
    expect(recs).toHaveLength(2);
    expect(ups[0]).toBeLessThan(recs[0]);
    expect(ups[1]).toBeLessThan(recs[1]);
  });

  it.each([
    ['subscription_cycle', true], ['subscription_create', true], ['subscription_update', false], ['manual', false],
  ])('invoice.payment_failed with %s notifies=%s', async (reason, notifies) => {
    (recordInvoice as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('invoice.payment_failed', stripeInvoice({ billingReason: reason, status: 'open' })), 'test');
    expect(recordInvoice).toHaveBeenCalledWith(expect.anything(), 'test', 'failed_payment', expect.any(String));
    expect((notifyHouseholdAdmins as jest.Mock).mock.calls.length > 0).toBe(notifies);
  });

  it('payment_action_required notifies with the hosted invoice URL', async () => {
    (linkInvoice as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('invoice.payment_action_required', stripeInvoice({ hostedInvoiceUrl: 'https://invoice.stripe.com/i/z' })), 'test');
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith('h1', 'billing_action_required', expect.any(String), expect.stringContaining('https://invoice.stripe.com/i/z'), expect.objectContaining({ url: 'https://invoice.stripe.com/i/z' }));
  });

  it.each(['refund.created', 'refund.updated', 'refund.failed'])('%s records a refund', async (t) => {
    await dispatchEvent(stripeEvent(t, stripeRefund({ id: 're_1' })), 'test');
    expect(recordRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 're_1' }), 'test', expect.any(String));
  });

  it('dispute created raises review and alerts staff', async () => {
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1', providerObjectId: 'dp_1' });
    await dispatchEvent(stripeEvent('charge.dispute.created', stripeDispute({ id: 'dp_1' })), 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispute_opened', providerObjectId: 'dp_1' }));
    expect(alertStaff).toHaveBeenCalled();
  });

  it('dispute closed as lost sets cancel_at_period_end on the allowed subscription (L4)', async () => {
    const s = installStripeMock('test');
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1', providerObjectId: 'dp_2' });
    (models.BillingSubscription.findOne as jest.Mock).mockResolvedValue({ providerSubscriptionId: 'sub_7', cancelAtPeriodEnd: false });
    s.subscriptions.update.mockResolvedValue({});
    await dispatchEvent(stripeEvent('charge.dispute.closed', stripeDispute({ id: 'dp_2', status: 'lost' })), 'test');
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_7', { cancel_at_period_end: true }, { idempotencyKey: 'dispute-lost:dp_2' });
    expect(upsertSubscription).toHaveBeenCalledWith('sub_7', 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispute_lost' }));
  });

  it.each(['charge.dispute.updated', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'])('%s records the dispute', async (t) => {
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent(t, stripeDispute()), 'test');
    expect(recordDispute).toHaveBeenCalled();
  });

  it('early fraud warning raises review and alerts', async () => {
    await dispatchEvent(stripeEvent('radar.early_fraud_warning.created', { id: 'issfr_1', charge: 'ch_1' }), 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'early_fraud_warning' }));
    expect(alertStaff).toHaveBeenCalled();
  });

  it('customer.updated keeps billing_email in sync', async () => {
    await dispatchEvent(stripeEvent('customer.updated', { id: 'cus_1', email: 'new@x' }), 'test');
    expect(models.BillingCustomer.update).toHaveBeenCalledWith({ billingEmail: 'new@x' }, { where: { provider: 'stripe', livemode: false, providerCustomerId: 'cus_1' } });
  });

  it('anything else is ignored', async () => {
    expect(await dispatchEvent(stripeEvent('payment_intent.created', {}), 'test')).toBe('ignored');
  });

  it('reads the env tag from metadata or the invoice parent', () => {
    expect(envOfEventObject({ metadata: { env: 'prod' } })).toBe('prod');
    expect(envOfEventObject(stripeInvoice({ subscriptionEnv: 'staging' }))).toBe('staging');
    expect(envOfEventObject({ id: 're_1' })).toBeUndefined();
  });
});
