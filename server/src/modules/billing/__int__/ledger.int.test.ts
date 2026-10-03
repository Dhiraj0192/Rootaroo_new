import { setupAssociations, BillingTransaction, BillingReconciliationItem, BillingSubscription, User } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { stripeInvoice, stripeRefund, stripeDispute } from '../../../test/billing/fixtures';
import { recordInvoice, recordRefund, recordDispute, anonymizeUserLedger, ANONYMIZED_EMAIL } from '../ledger';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function linked() {
  const { household, admin } = await createHouseholdWithAdmin({ name: 'Rai Family' });
  await createCustomerRow(household.id, { providerCustomerId: 'cus_L' });
  const sub = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_L', purchasedByUserId: admin.id });
  s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_L', latest_charge: 'ch_L' } }, invoice: stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }) }]));
  s.charges.retrieve.mockResolvedValue({ id: 'ch_L', customer: 'cus_L', receipt_url: 'https://pay.stripe.com/receipts/x', balance_transaction: { fee: 56, net: 843 } });
  return { household, admin, sub };
}

describe('ledger', () => {
  it('records a linked payment with fee and net (criterion 4)', async () => {
    const { household, admin, sub } = await linked();
    const row = await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L', billingReason: 'subscription_cycle', amountPaid: 899 }), 'test', 'payment', 'evt_1');
    expect(row).toMatchObject({
      type: 'payment', status: 'paid', amount: 899, fee: 56, net: 843, householdId: household.id, userId: admin.id, subscriptionId: sub.id,
      matchStatus: 'matched', householdNameSnapshot: 'Rai Family', providerChargeId: 'ch_L', billingReason: 'subscription_cycle', lastEventId: 'evt_1',
    });
    expect(s.invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_L', limit: 10, expand: ['data.payment.payment_intent'] });
    expect(s.charges.retrieve).toHaveBeenCalledWith('ch_L', { expand: ['balance_transaction'] });
  });

  it('keeps fee NULL when unavailable, for reconciliation to fill', async () => {
    await linked();
    s.charges.retrieve.mockResolvedValue({ id: 'ch_L', balance_transaction: null, receipt_url: null });
    expect((await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null)).fee).toBeNull();
  });

  it('one failed_payment row per invoice, updated in place', async () => {
    await linked();
    await recordInvoice(stripeInvoice({ id: 'in_F', customer: 'cus_L', subscriptionId: 'sub_L', status: 'open', amountDue: 899 }), 'test', 'failed_payment', 'evt_a');
    await recordInvoice(stripeInvoice({ id: 'in_F', customer: 'cus_L', subscriptionId: 'sub_L', status: 'open', amountDue: 899 }), 'test', 'failed_payment', 'evt_b');
    const rows = await BillingTransaction.findAll({ where: { providerObjectId: 'in_F' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'failed_payment', status: 'failed', lastEventId: 'evt_b' });
  });

  it('falls back to the customer, then unmatched + review', async () => {
    const { household } = await linked();
    expect((await recordInvoice(stripeInvoice({ id: 'in_C', customer: 'cus_L', subscriptionId: null }), 'test', 'payment', null)).householdId).toBe(household.id);
    const orphan = await recordInvoice(stripeInvoice({ id: 'in_O', customer: 'cus_none', subscriptionId: 'sub_none' }), 'test', 'payment', null);
    expect(orphan.matchStatus).toBe('unmatched');
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_invoice', providerObjectId: 'in_O' } })).toBe(1);
  });

  it('records refunds per refund object, keeping status current (L3)', async () => {
    const { household } = await linked();
    await recordRefund(stripeRefund({ id: 're_1', amount: 400, status: 'pending', paymentIntent: 'pi_L', charge: 'ch_L' }), 'test', 'evt_r1');
    const row = await recordRefund(stripeRefund({ id: 're_1', amount: 400, status: 'succeeded', paymentIntent: 'pi_L', charge: 'ch_L' }), 'test', 'evt_r2');
    expect(row).toMatchObject({ type: 'refund', amount: 400, status: 'succeeded', householdId: household.id, providerInvoiceId: 'in_L' });
    expect(await BillingTransaction.count({ where: { type: 'refund' } })).toBe(1);
  });

  it('records disputes with funds state and fee', async () => {
    const { household } = await linked();
    const row = await recordDispute(stripeDispute({ id: 'dp_1', paymentIntent: 'pi_L', status: 'lost', balanceTransactions: [{ amount: -899, fee: 1500 }] }), 'test', 'evt_d');
    expect(row).toMatchObject({ type: 'dispute', status: 'lost', fundsState: 'withdrawn', disputeFee: 1500, householdId: household.id });
  });

  it('anonymises a deleted user and stays anonymised on re-record (§5.11)', async () => {
    const { admin } = await linked();
    await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(await anonymizeUserLedger(admin.id)).toBe(1);
    const again = await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(again).toMatchObject({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL });
  });
});

describe('ledger: deleted purchasers (finding 4)', () => {
  it('stores the anonymised email when the linked subscription purchaser is soft-deleted', async () => {
    const { admin } = await linked();
    await admin.destroy();
    const row = await recordInvoice(stripeInvoice({ id: 'in_D1', customer: 'cus_L', subscriptionId: 'sub_L', customerEmail: null }), 'test', 'payment', null);
    expect(row).toMatchObject({ payerEmailSnapshot: ANONYMIZED_EMAIL, userId: null, matchStatus: 'matched' });
  });

  it('stores the anonymised email when the purchaser was cleared (null) or the user row is anonymised', async () => {
    const { household, sub, admin } = await linked();
    await sub.update({ purchasedByUserId: null });
    const a = await recordInvoice(stripeInvoice({ id: 'in_D2', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(a.payerEmailSnapshot).toBe(ANONYMIZED_EMAIL);
    await sub.update({ purchasedByUserId: admin.id });
    await admin.update({ email: `deleted-${admin.id}@deleted.rootaroo.local` });
    const b = await recordInvoice(stripeInvoice({ id: 'in_D3', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(b.payerEmailSnapshot).toBe(ANONYMIZED_EMAIL);
    expect(household.id).toBe(b.householdId);
  });

  it('stores the anonymised email when the invoice email belongs to a soft-deleted user', async () => {
    const { admin } = await linked();
    const gone = await User.findByPk(admin.id);
    await gone!.destroy();
    const row = await recordInvoice(stripeInvoice({ id: 'in_D4', customer: 'cus_L', subscriptionId: null, customerEmail: admin.email }), 'test', 'payment', null);
    expect(row.payerEmailSnapshot).toBe(ANONYMIZED_EMAIL);
  });

  it('keeps the invoice email for a live purchaser', async () => {
    await linked();
    const row = await recordInvoice(stripeInvoice({ id: 'in_D5', customer: 'cus_L', subscriptionId: 'sub_L', customerEmail: 'payer@example.test' }), 'test', 'payment', null);
    expect(row.payerEmailSnapshot).toBe('payer@example.test');
  });

  it('anonymizeUserLedger also covers rows matched only by the email snapshot', async () => {
    const { household, admin } = await linked();
    const base = { provider: 'stripe' as const, livemode: false, type: 'payment' as const, status: 'paid', amount: 899, currency: 'usd', matchStatus: 'matched' as const, householdId: household.id, occurredAt: new Date() };
    await BillingTransaction.create({ ...base, providerObjectId: 'in_E1', userId: admin.id, payerEmailSnapshot: 'x@y.test' });
    await BillingTransaction.create({ ...base, providerObjectId: 'in_E2', userId: null, payerEmailSnapshot: 'Orig@Example.test' });
    await BillingTransaction.create({ ...base, providerObjectId: 'in_E3', userId: null, payerEmailSnapshot: 'someone-else@example.test' });
    expect(await anonymizeUserLedger(admin.id, 'orig@example.test')).toBe(2);
    expect((await BillingTransaction.findOne({ where: { providerObjectId: 'in_E2' } }))!.payerEmailSnapshot).toBe(ANONYMIZED_EMAIL);
    expect((await BillingTransaction.findOne({ where: { providerObjectId: 'in_E3' } }))!.payerEmailSnapshot).toBe('someone-else@example.test');
    expect(await BillingSubscription.count()).toBe(1);
  });
});
