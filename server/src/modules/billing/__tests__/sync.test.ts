import { mapStripeSubscription, computeGraceUntil } from '../sync';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';

describe('mapStripeSubscription', () => {
  it('reads price, seats, set, amount and the item-level period', () => {
    const sub = stripeSubscription({ seats: 7, interval: 'year', periodStart: 1_700_000_000, periodEnd: 1_731_536_000, customer: 'cus_9', cancelAtPeriodEnd: true });
    const m = mapStripeSubscription(sub);
    expect(m).toMatchObject({
      status: 'active', interval: 'year', seats: 7, priceSet: '2026-10', unitAmount: 12775, currency: 'usd',
      cancelAtPeriodEnd: true, customerId: 'cus_9', pendingUpdate: null,
    });
    expect(m.currentPeriodStart!.getTime()).toBe(1_700_000_000_000);
    expect(m.currentPeriodEnd!.getTime()).toBe(1_731_536_000_000);
  });

  it('falls back to the lookup key for seats and returns null when unknown', () => {
    const sub = stripeSubscription({ seats: 9 });
    (sub.items.data[0].price as any).metadata = {};
    expect(mapStripeSubscription(sub).seats).toBe(9);
    (sub.items.data[0].price as any).lookup_key = null;
    expect(mapStripeSubscription(sub).seats).toBeNull();
  });

  it('keeps pending_update', () => {
    expect(mapStripeSubscription(stripeSubscription({ pendingUpdate: { expires_at: 5 } })).pendingUpdate).toEqual({ expires_at: 5 });
  });
});

describe('computeGraceUntil (§7.1, T7)', () => {
  const inv = stripeInvoice({ created: 1_000_000, finalizedAt: 1_000_600 });

  it('starts at finalized_at + grace days on first past_due', () => {
    expect(computeGraceUntil('past_due', null, inv, 7)!.getTime()).toBe((1_000_600 + 7 * 86400) * 1000);
  });

  it('falls back to invoice.created when not finalized', () => {
    expect(computeGraceUntil('past_due', null, stripeInvoice({ created: 2_000_000, finalizedAt: null }), 7)!.getTime()).toBe((2_000_000 + 7 * 86400) * 1000);
  });

  it('keeps an existing grace while still past_due', () => {
    const existing = new Date('2026-10-20T00:00:00Z');
    expect(computeGraceUntil('past_due', existing, inv, 7)).toBe(existing);
  });

  it.each(['active', 'trialing', 'unpaid', 'canceled', 'incomplete'] as const)('clears grace for %s', (status) => {
    expect(computeGraceUntil(status, new Date(), inv, 7)).toBeNull();
  });

  it('returns null when latest_invoice is not expanded', () => {
    expect(computeGraceUntil('past_due', null, 'in_1', 7)).toBeNull();
  });
});
