jest.mock('../../api/billing', () => ({ billingApi: {} }));
jest.mock('../iap', () => ({ purchaseSubscription: jest.fn(), restoreStorePurchases: jest.fn() }));
jest.mock('../../store/billingStore', () => ({ useBillingStore: { getState: () => ({ refresh: jest.fn(), applySync: jest.fn() }) } }));

import { startStripeCheckout, startPurchase, restorePurchases, canStartPurchase, openBillingPortal, describeCheckoutError, RETURN_URL } from '../purchase';
import { purchaseSubscription, restoreStorePurchases } from '../iap';

function deps(overrides = {}) {
  let t = 0;
  return {
    api: {
      createCheckout: jest.fn(async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' })),
      syncCheckout: jest.fn(async () => ({ entitlement: { allowed: true }, pendingCheckout: { sessionId: 'cs_test_1', state: 'complete' } })),
      openPortal: jest.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' })),
    },
    openAuthSession: jest.fn(async () => ({ type: 'success', url: 'rootaroo://billing/success?session_id=cs_test_1' })),
    openBrowser: jest.fn(),
    refreshStatus: jest.fn(async () => ({ entitlement: { allowed: true } })),
    applySync: jest.fn(),
    sleep: jest.fn(async (ms) => { t += ms; }),
    now: () => t,
    ...overrides,
  };
}

describe('startStripeCheckout', () => {
  it('opens Checkout with the return scheme, syncs and unlocks', async () => {
    const d = deps();
    const r = await startStripeCheckout({ interval: 'year', seats: 7 }, d);
    expect(d.api.createCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 7 });
    expect(d.openAuthSession).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1', RETURN_URL);
    expect(d.api.syncCheckout).toHaveBeenCalledWith('cs_test_1');
    expect(r.outcome).toBe('unlocked');
  });

  it.each(['cancel', 'dismiss'])('always syncs, even when the browser reports %s (T3, Android)', async (type) => {
    const d = deps({ openAuthSession: jest.fn(async () => ({ type })) });
    await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(d.api.syncCheckout).toHaveBeenCalledWith('cs_test_1');
  });

  it('still syncs when the browser call itself throws', async () => {
    const d = deps({ openAuthSession: jest.fn(async () => { throw new Error('boom'); }) });
    await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(d.api.syncCheckout).toHaveBeenCalledWith('cs_test_1');
  });

  it('polls every 2 s for up to 30 s while processing, then reports confirming (T4)', async () => {
    const d = deps({
      api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } })) },
      refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })),
    });
    const r = await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(r.outcome).toBe('confirming');
    expect(d.sleep).toHaveBeenCalledWith(2000);
    expect(d.refreshStatus.mock.calls.length).toBeGreaterThanOrEqual(15);
    expect(d.refreshStatus.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it('stops polling as soon as entitlement arrives', async () => {
    const refreshStatus = jest.fn().mockResolvedValueOnce({ entitlement: { allowed: false } }).mockResolvedValueOnce({ entitlement: { allowed: true } });
    const d = deps({ api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } })) }, refreshStatus });
    expect((await startStripeCheckout({ interval: 'month', seats: 5 }, d)).outcome).toBe('unlocked');
    expect(refreshStatus).toHaveBeenCalledTimes(2);
  });

  it('reports not_completed after a cancelled checkout', async () => {
    const d = deps({
      openAuthSession: jest.fn(async () => ({ type: 'cancel' })),
      api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'open' } })) },
      refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })),
    });
    expect((await startStripeCheckout({ interval: 'month', seats: 5 }, d)).outcome).toBe('not_completed');
  });

  it('turns API errors into an error outcome without throwing', async () => {
    const err = { response: { status: 409, data: { code: 'PAYMENT_ISSUE', portalUrl: 'https://billing.stripe.com/p/x' } } };
    const d = deps({ api: { ...deps().api, createCheckout: jest.fn(async () => { throw err; }) } });
    const r = await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(r).toMatchObject({ outcome: 'error', error: { portalUrl: 'https://billing.stripe.com/p/x' } });
  });
});

describe('describeCheckoutError', () => {
  it.each([
    ['ALREADY_SUBSCRIBED', /already/i], ['PAYMENT_ISSUE', /payment/i], ['SEATS_BELOW_MEMBERS', /members/i],
    ['PURCHASE_METHOD_MISMATCH', /isn't available here/i], ['BILLING_MODE_UNAVAILABLE', /isn't available/i], ['LOCK_BUSY', /moment/i],
  ])('%s', (code, re) => {
    expect(describeCheckoutError({ response: { data: { code, memberCount: 7 } } }).message).toMatch(re);
  });

  it('falls back for network errors', () => {
    expect(describeCheckoutError(new Error('Network Error')).message).toMatch(/connection/i);
  });
});

describe('openBillingPortal', () => {
  it('opens the portal with the return scheme then refreshes', async () => {
    const d = deps();
    await openBillingPortal(d);
    expect(d.openAuthSession).toHaveBeenCalledWith('https://billing.stripe.com/p/session/x', RETURN_URL);
    expect(d.refreshStatus).toHaveBeenCalled();
  });
});

describe('startPurchase (section 12 dispatch)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stripe_checkout opens hosted Checkout', async () => {
    const d = deps();
    const r = await startPurchase({ method: 'stripe_checkout', interval: 'year', seats: 7 }, d);
    expect(d.api.createCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 7 });
    expect(purchaseSubscription).not.toHaveBeenCalled();
    expect(r.outcome).toBe('unlocked');
  });

  it.each(['apple_iap', 'google_play'])('%s goes through the store purchase and never touches Stripe', async (method) => {
    purchaseSubscription.mockResolvedValue({ outcome: 'unlocked' });
    const d = deps();
    const r = await startPurchase({ method, interval: 'month', seats: 6 }, d);
    expect(purchaseSubscription).toHaveBeenCalledWith({ interval: 'month', seats: 6 }, undefined);
    expect(d.api.createCheckout).not.toHaveBeenCalled();
    expect(r.outcome).toBe('unlocked');
  });

  it('an already-owned store subscription is restored onto the household instead of bought again', async () => {
    purchaseSubscription.mockResolvedValue({ outcome: 'already_owned' });
    restoreStorePurchases.mockResolvedValue({ outcome: 'unlocked', verified: 1 });
    expect((await startPurchase({ method: 'apple_iap', interval: 'month', seats: 5 }, deps())).outcome).toBe('unlocked');
    expect(restoreStorePurchases).toHaveBeenCalled();
  });

  it('refuses a method this build cannot start (none)', async () => {
    const r = await startPurchase({ method: 'none', interval: 'month', seats: 5 }, deps());
    expect(r.outcome).toBe('error');
    expect(canStartPurchase('none')).toBe(false);
    expect(['stripe_checkout', 'apple_iap', 'google_play'].every(canStartPurchase)).toBe(true);
  });
});

describe('restorePurchases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-verifies with the store for IAP and just refreshes status for Stripe', async () => {
    restoreStorePurchases.mockResolvedValue({ outcome: 'confirming' });
    expect((await restorePurchases({ method: 'google_play' }, deps())).outcome).toBe('confirming');
    const d = deps();
    expect((await restorePurchases({ method: 'stripe_checkout' }, d)).outcome).toBe('refreshed');
    expect(d.refreshStatus).toHaveBeenCalled();
  });
});
