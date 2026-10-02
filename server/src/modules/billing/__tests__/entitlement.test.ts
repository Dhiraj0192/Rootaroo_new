import { computeEntitlement, SubscriptionSnapshot } from '../entitlement';
import type { SubscriptionStatus } from '../types';

const NOW = new Date('2026-10-10T12:00:00Z');
const snap = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: 'row1', provider: 'stripe', status: 'active', seats: 7, interval: 'month', graceUntil: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: false, ...o,
});
const future = new Date(NOW.getTime() + 3600_000);
const past = new Date(NOW.getTime() - 3600_000);

describe('computeEntitlement (§7.1)', () => {
  const statuses: SubscriptionStatus[] = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'];

  for (const mode of ['test', 'live'] as const) {
    for (const status of statuses) {
      for (const grace of [null, future, past]) {
        const label = `${mode}/${status}/grace=${grace === null ? 'none' : grace === future ? 'future' : 'past'}`;

        it(`live cohort ${label}`, () => {
          const e = computeEntitlement({ cohort: 'live', mode, subscriptions: [snap({ status, graceUntil: grace })], now: NOW });
          const allowed = status === 'active' || status === 'trialing' || (status === 'past_due' && grace === future);
          expect(e.allowed).toBe(allowed);
          expect(e.mode).toBe(mode);
          if (status === 'active' || status === 'trialing') expect(e).toMatchObject({ reason: 'active', seatsAllowed: 7 });
          else if (allowed) expect(e).toMatchObject({ reason: 'grace', seatsAllowed: 7, graceUntil: future.toISOString() });
          else expect(e).toMatchObject({ reason: 'subscription_required', seatsAllowed: 5 });
        });

        it(`test cohort ${label} is always allowed with 10 seats`, () => {
          const e = computeEntitlement({ cohort: 'test', mode, subscriptions: [snap({ status, graceUntil: grace })], now: NOW });
          expect(e).toMatchObject({ allowed: true, reason: 'test_cohort', seatsAllowed: 10 });
        });
      }
    }
  }

  it('no subscription -> subscription_required with 5 seats', () => {
    expect(computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [], now: NOW }))
      .toEqual({ allowed: false, reason: 'subscription_required', mode: 'live', subscription: null, graceUntil: null, seatsAllowed: 5 });
  });

  it('grace boundary: now == graceUntil is blocked', () => {
    expect(computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [snap({ status: 'past_due', graceUntil: NOW })], now: NOW }).allowed).toBe(false);
  });

  it('prefers a healthy subscription over a past_due one', () => {
    const e = computeEntitlement({
      cohort: 'live', mode: 'live', now: NOW,
      subscriptions: [snap({ id: 'old', status: 'active', seats: 6, createdAt: new Date('2026-01-01') }), snap({ id: 'new', status: 'past_due', graceUntil: past, createdAt: new Date('2026-10-05') })],
    });
    expect(e).toMatchObject({ allowed: true, reason: 'active', seatsAllowed: 6, subscription: { id: 'old' } });
  });

  it('exposes the subscription view with ISO dates', () => {
    const e = computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [snap()], now: NOW });
    expect(e.subscription).toEqual({ id: 'row1', provider: 'stripe', status: 'active', seats: 7, interval: 'month', currentPeriodEnd: '2026-11-01T00:00:00.000Z', cancelAtPeriodEnd: false });
  });
});
