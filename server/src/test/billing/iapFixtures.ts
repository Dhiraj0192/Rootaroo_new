import type { VerifiedPurchase } from '../../modules/billing/iap/types';

let n = 0;

export function verifiedPurchase(overrides: Partial<VerifiedPurchase> = {}): VerifiedPurchase {
  n += 1;
  return {
    provider: 'apple', livemode: false, productId: 'rootaroo.hh5.month', seats: 5, interval: 'month',
    subscriptionId: `2000000${String(n).padStart(6, '0')}`, status: 'active',
    currentPeriodStart: new Date(Date.now() - 86400_000), expiresAt: new Date(Date.now() + 29 * 86400_000),
    cancelAtPeriodEnd: false, canceledAt: null, endedAt: null, graceUntil: null, pendingUpdate: null,
    householdId: null, unitAmount: 899, currency: 'usd',
    ...overrides,
  };
}
