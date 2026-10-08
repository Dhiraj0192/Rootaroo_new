const SIZES = [5, 6, 7, 8, 9, 10];
const month = (n) => 899 + 199 * (n - 5);
const year = (n) => 7999 + 2388 * (n - 5);

export const PLANS = {
  mode: 'test', priceSet: '2026-10', currency: 'usd', seatsIncluded: 5, seatsMax: 10,
  matrix: {
    month: Object.fromEntries(SIZES.map((n) => [String(n), { priceId: `price_m${n}`, amount: month(n) }])),
    year: Object.fromEntries(SIZES.map((n) => [String(n), { priceId: `price_y${n}`, amount: year(n) }])),
  },
};

export function statusFixture(overrides = {}) {
  return {
    entitlement: { allowed: false, reason: 'subscription_required', mode: 'test', subscription: null, graceUntil: null, seatsAllowed: 5 },
    subscription: null, isAdmin: true, adminNames: ['Asha'], purchaseMethod: 'stripe_checkout', plans: PLANS,
    pendingCheckout: null, memberCount: 3, ...overrides,
  };
}

test.skip('fixtures module', () => {});
