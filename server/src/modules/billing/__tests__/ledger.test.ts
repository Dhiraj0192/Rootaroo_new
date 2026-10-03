import { disputeFunds, mergeLedgerFields, invoiceSubscriptionId, ANONYMIZED_EMAIL } from '../ledger';
import { stripeDispute, stripeInvoice } from '../../../test/billing/fixtures';

describe('ledger helpers', () => {
  it('reads the subscription from invoice.parent (pinned API shape)', () => {
    expect(invoiceSubscriptionId(stripeInvoice({ subscriptionId: 'sub_9' }))).toBe('sub_9');
    expect(invoiceSubscriptionId(stripeInvoice({ subscriptionId: null }))).toBeNull();
  });

  it('derives dispute funds state and fee (L4)', () => {
    expect(disputeFunds(stripeDispute())).toEqual({ fundsState: 'none', disputeFee: 0 });
    expect(disputeFunds(stripeDispute({ balanceTransactions: [{ amount: -899, fee: 1500 }] }))).toEqual({ fundsState: 'withdrawn', disputeFee: 1500 });
    expect(disputeFunds(stripeDispute({ balanceTransactions: [{ amount: -899, fee: 1500 }, { amount: 899, fee: -1500 }] }))).toEqual({ fundsState: 'reinstated', disputeFee: 0 });
  });

  it('never replaces known fees with null and keeps anonymisation', () => {
    const existing: any = { fee: 56, net: 843, providerChargeId: 'ch_1', receiptUrl: 'r', disputeFee: null, payerEmailSnapshot: ANONYMIZED_EMAIL, userId: null, matchStatus: 'matched', householdId: 'h1', subscriptionId: 's1', householdNameSnapshot: 'Fam' };
    const merged = mergeLedgerFields(existing, { fee: null, net: null, providerChargeId: null, userId: 'u1', payerEmailSnapshot: 'a@x', amount: 899 });
    expect(merged).toMatchObject({ fee: 56, net: 843, providerChargeId: 'ch_1', userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL, amount: 899 });
  });

  it('does not downgrade a matched row to unmatched', () => {
    const existing: any = { matchStatus: 'matched', householdId: 'h1', userId: 'u1', subscriptionId: 's1', householdNameSnapshot: 'Fam', payerEmailSnapshot: 'a@x' };
    expect(mergeLedgerFields(existing, { matchStatus: 'unmatched', householdId: null, userId: null, subscriptionId: null })).toMatchObject({ matchStatus: 'matched', householdId: 'h1', subscriptionId: 's1' });
  });

  it('fills null userId/subscriptionId on a matched row and never blanks known ones (finding 3)', () => {
    const customerMatched: any = { matchStatus: 'matched', householdId: 'h1', userId: null, subscriptionId: null, householdNameSnapshot: 'Fam', payerEmailSnapshot: 'a@x' };
    expect(mergeLedgerFields(customerMatched, { matchStatus: 'matched', householdId: 'h1', userId: 'u1', subscriptionId: 's1' })).toMatchObject({ userId: 'u1', subscriptionId: 's1' });
    const subMatched: any = { matchStatus: 'matched', householdId: 'h1', userId: 'u1', subscriptionId: 's1', householdNameSnapshot: 'Fam', payerEmailSnapshot: 'a@x' };
    expect(mergeLedgerFields(subMatched, { matchStatus: 'matched', householdId: 'h1', userId: null, subscriptionId: null })).toMatchObject({ userId: 'u1', subscriptionId: 's1' });
  });
});
