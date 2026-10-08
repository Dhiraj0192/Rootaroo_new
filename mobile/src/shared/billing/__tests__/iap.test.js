jest.mock('../../api/billing', () => ({ billingApi: {} }));
jest.mock('../../store/billingStore', () => ({ useBillingStore: { getState: () => ({ status: null, refresh: jest.fn() }) } }));

const iapModule = require('../iap');

const {
  purchaseSubscription, restoreStorePurchases, startPurchaseRecovery, initStoreCountry, fetchStorePrices, manageStoreSubscription,
  skuFor, allSkus, isOurSku, iapAvailable, PURCHASE_ERRORS, __resetIapForTests,
} = iapModule;

/** A stand-in for the native expo-iap module that lets a test play the store's side of a purchase. */
function fakeIap({ onRequest, products = [], available = [] } = {}) {
  const updated = [];
  const failed = [];
  const iap = {
    initConnection: jest.fn(async () => true),
    getStorefront: jest.fn(async () => 'USA'),
    fetchProducts: jest.fn(async () => products),
    requestPurchase: jest.fn(async () => { if (onRequest) await onRequest({ emit: (p) => updated.forEach((cb) => cb(p)), fail: (e) => failed.forEach((cb) => cb(e)) }); }),
    purchaseUpdatedListener: jest.fn((cb) => { updated.push(cb); return { remove: jest.fn(() => updated.splice(updated.indexOf(cb), 1)) }; }),
    purchaseErrorListener: jest.fn((cb) => { failed.push(cb); return { remove: jest.fn(() => failed.splice(failed.indexOf(cb), 1)) }; }),
    finishTransaction: jest.fn(async () => {}),
    restorePurchases: jest.fn(async () => {}),
    getAvailablePurchases: jest.fn(async () => available),
    deepLinkToSubscriptions: jest.fn(async () => {}),
  };
  return { iap, listeners: { updated, failed }, emit: (p) => updated.forEach((cb) => cb(p)) };
}

function deps(iap, overrides = {}) {
  return {
    iap,
    api: {
      verifyApple: jest.fn(async () => ({ entitlement: { allowed: true } })),
      verifyGoogle: jest.fn(async () => ({ entitlement: { allowed: true } })),
    },
    provider: () => 'apple',
    householdId: () => 'hh-uuid-1',
    refreshStatus: jest.fn(async () => ({ entitlement: { allowed: true } })),
    openUrl: jest.fn(async () => {}),
    setCountry: jest.fn(),
    ...overrides,
  };
}

const applePurchase = (o = {}) => ({ productId: 'rootaroo.hh7.year', purchaseToken: 'eyJ.signed.jws', purchaseState: 'purchased', ...o });
const googlePurchase = (o = {}) => ({ productId: 'rootaroo.hh7', purchaseToken: 'play-token-1', purchaseState: 'purchased', ...o });

beforeEach(() => __resetIapForTests());

describe('sku helpers', () => {
  it('Apple has a product per size and interval; Google one subscription per size', () => {
    expect(skuFor('apple', 7, 'year')).toBe('rootaroo.hh7.year');
    expect(skuFor('google', 7, 'year')).toBe('rootaroo.hh7');
    expect(allSkus('apple')).toHaveLength(12);
    expect(allSkus('google')).toEqual(['rootaroo.hh5', 'rootaroo.hh6', 'rootaroo.hh7', 'rootaroo.hh8', 'rootaroo.hh9', 'rootaroo.hh10']);
  });

  it('recognises only our products', () => {
    expect(isOurSku('rootaroo.hh10.month')).toBe(true);
    expect(isOurSku('rootaroo.hh7')).toBe(true);
    expect(isOurSku('rootaroo.hh4.month')).toBe(false);
    expect(isOurSku('com.other.sub')).toBe(false);
  });

  it('is unavailable without the native module or off iOS/Android', () => {
    expect(iapAvailable({ iap: null, provider: () => 'apple' })).toBe(false);
    expect(iapAvailable({ iap: {}, provider: () => 'apple' })).toBe(false);
    expect(iapAvailable({ iap: { initConnection: jest.fn() }, provider: () => null })).toBe(false);
    expect(iapAvailable({ iap: { initConnection: jest.fn() }, provider: () => 'google' })).toBe(true);
  });
});

describe('purchaseSubscription (Apple)', () => {
  it('sets appAccountToken to the household, verifies the signed transaction, then finishes it and refreshes', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => emit(applePurchase()) });
    const d = deps(f.iap);
    const r = await purchaseSubscription({ interval: 'year', seats: 7 }, d);
    expect(f.iap.requestPurchase).toHaveBeenCalledWith({ type: 'subs', request: { apple: { sku: 'rootaroo.hh7.year', appAccountToken: 'hh-uuid-1' } } });
    expect(d.api.verifyApple).toHaveBeenCalledWith('eyJ.signed.jws');
    expect(f.iap.finishTransaction).toHaveBeenCalledWith({ purchase: expect.objectContaining({ productId: 'rootaroo.hh7.year' }), isConsumable: false });
    expect(d.api.verifyApple.mock.invocationCallOrder[0]).toBeLessThan(f.iap.finishTransaction.mock.invocationCallOrder[0]);
    expect(r.outcome).toBe('unlocked');
    expect(f.listeners.updated).toHaveLength(0); // listeners are removed afterwards
  });

  it('ignores updates for other products while waiting', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => { emit(applePurchase({ productId: 'rootaroo.hh5.month' })); emit(applePurchase()); } });
    const d = deps(f.iap);
    await purchaseSubscription({ interval: 'year', seats: 7 }, d);
    expect(d.api.verifyApple).toHaveBeenCalledTimes(1);
  });

  it('a store-side cancel (error listener) is not_completed and verifies nothing', async () => {
    const f = fakeIap({ onRequest: ({ fail }) => fail({ code: 'user-cancelled' }) });
    const d = deps(f.iap);
    expect((await purchaseSubscription({ interval: 'month', seats: 5 }, d)).outcome).toBe('not_completed');
    expect(d.api.verifyApple).not.toHaveBeenCalled();
  });

  it('a rejected requestPurchase maps user-cancelled, deferred and already-owned', async () => {
    for (const [code, outcome] of [['user-cancelled', 'not_completed'], ['deferred-payment', 'pending'], ['already-owned', 'already_owned'], ['service-error', 'error']]) {
      __resetIapForTests();
      const f = fakeIap();
      f.iap.requestPurchase.mockRejectedValue({ code });
      const r = await purchaseSubscription({ interval: 'month', seats: 5 }, deps(f.iap));
      expect(r.outcome).toBe(outcome);
      expect(f.listeners.updated).toHaveLength(0);
    }
  });

  it('a pending purchase (Ask to Buy) is not verified or finished', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => emit(applePurchase({ purchaseState: 'pending' })) });
    const d = deps(f.iap);
    expect((await purchaseSubscription({ interval: 'year', seats: 7 }, d)).outcome).toBe('pending');
    expect(d.api.verifyApple).not.toHaveBeenCalled();
    expect(f.iap.finishTransaction).not.toHaveBeenCalled();
  });

  it('when the server cannot verify, the transaction stays unfinished so it is retried', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => emit(applePurchase()) });
    const d = deps(f.iap);
    d.api.verifyApple.mockRejectedValue(new Error('Network Error'));
    const r = await purchaseSubscription({ interval: 'year', seats: 7 }, d);
    expect(r).toEqual({ outcome: 'error', error: PURCHASE_ERRORS.network });
    expect(f.iap.finishTransaction).not.toHaveBeenCalled();
  });

  it('a purchase that belongs to another household is reported, not finished', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => emit(applePurchase()) });
    const d = deps(f.iap);
    d.api.verifyApple.mockRejectedValue({ response: { status: 409, data: { code: 'PURCHASE_HOUSEHOLD_MISMATCH' } } });
    const r = await purchaseSubscription({ interval: 'year', seats: 7 }, d);
    expect(r.error).toEqual(PURCHASE_ERRORS.mismatch);
    expect(f.iap.finishTransaction).not.toHaveBeenCalled();
  });

  it('reports confirming when verified but the entitlement has not flipped yet', async () => {
    const f = fakeIap({ onRequest: ({ emit }) => emit(applePurchase()) });
    const d = deps(f.iap, { refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })) });
    expect((await purchaseSubscription({ interval: 'year', seats: 7 }, d)).outcome).toBe('confirming');
  });

  it('refuses without a household id or without the native module', async () => {
    const f = fakeIap();
    expect((await purchaseSubscription({ interval: 'year', seats: 7 }, deps(f.iap, { householdId: () => null }))).outcome).toBe('error');
    expect(f.iap.requestPurchase).not.toHaveBeenCalled();
    expect(await purchaseSubscription({ interval: 'year', seats: 7 }, deps(null))).toEqual({ outcome: 'error', error: PURCHASE_ERRORS.unavailable });
  });
});

describe('purchaseSubscription (Google Play)', () => {
  const products = [{
    id: 'rootaroo.hh7',
    subscriptionOffers: [
      { basePlanIdAndroid: 'month', offerTokenAndroid: 'tok-month', displayPrice: '$12.97' },
      { basePlanIdAndroid: 'year', offerTokenAndroid: 'tok-year', displayPrice: '$134.27' },
    ],
  }];

  it('buys the base plan offer for the interval, tags the household, and verifies the token with the product id', async () => {
    const f = fakeIap({ products, onRequest: ({ emit }) => emit(googlePurchase()) });
    const d = deps(f.iap, { provider: () => 'google' });
    const r = await purchaseSubscription({ interval: 'year', seats: 7 }, d);
    expect(f.iap.requestPurchase).toHaveBeenCalledWith({
      type: 'subs',
      request: { google: { skus: ['rootaroo.hh7'], obfuscatedAccountId: 'hh-uuid-1', subscriptionOffers: [{ sku: 'rootaroo.hh7', offerToken: 'tok-year' }] } },
    });
    expect(d.api.verifyGoogle).toHaveBeenCalledWith({ purchaseToken: 'play-token-1', productId: 'rootaroo.hh7' });
    expect(f.iap.finishTransaction).toHaveBeenCalled();
    expect(r.outcome).toBe('unlocked');
  });

  it('is unavailable when Play has no offer for the plan', async () => {
    const f = fakeIap({ products: [{ id: 'rootaroo.hh7', subscriptionOffers: [] }] });
    const r = await purchaseSubscription({ interval: 'year', seats: 7 }, deps(f.iap, { provider: () => 'google' }));
    expect(r).toEqual({ outcome: 'error', error: PURCHASE_ERRORS.unavailable });
    expect(f.iap.requestPurchase).not.toHaveBeenCalled();
  });
});

describe('restoreStorePurchases', () => {
  it('re-verifies each of our purchases, skips foreign products and pending ones, and unlocks', async () => {
    const f = fakeIap({ available: [applePurchase(), applePurchase({ productId: 'com.other.sub' }), applePurchase({ purchaseState: 'pending', productId: 'rootaroo.hh5.month' })] });
    const d = deps(f.iap);
    const r = await restoreStorePurchases(d);
    expect(f.iap.restorePurchases).toHaveBeenCalled();
    expect(d.api.verifyApple).toHaveBeenCalledTimes(1);
    expect(f.iap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ outcome: 'unlocked', verified: 1 });
  });

  it('reports nothing_to_restore, and a mismatch for a purchase owned by another household', async () => {
    const empty = fakeIap();
    expect((await restoreStorePurchases(deps(empty.iap, { refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })) }))).outcome).toBe('nothing_to_restore');

    const other = fakeIap({ available: [applePurchase()] });
    const d = deps(other.iap, { refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })) });
    d.api.verifyApple.mockRejectedValue({ response: { status: 409, data: { code: 'PURCHASE_HOUSEHOLD_MISMATCH' } } });
    const r = await restoreStorePurchases(d);
    expect(r.outcome).toBe('error');
    expect(r.error).toEqual(PURCHASE_ERRORS.mismatch);
    expect(other.iap.finishTransaction).not.toHaveBeenCalled();
  });

  it('is an error without the native module', async () => {
    expect((await restoreStorePurchases(deps(null))).outcome).toBe('error');
  });
});

describe('startPurchaseRecovery', () => {
  const settle = () => new Promise((r) => setImmediate(r));

  it('verifies and finishes a purchase that arrives outside a purchase flow, and stops on cleanup', async () => {
    const f = fakeIap();
    const d = deps(f.iap);
    const stop = startPurchaseRecovery(d);
    await settle();
    f.emit(applePurchase());
    await settle();
    expect(d.api.verifyApple).toHaveBeenCalledWith('eyJ.signed.jws');
    expect(f.iap.finishTransaction).toHaveBeenCalled();
    stop();
    expect(f.listeners.updated).toHaveLength(0);
  });

  it('ignores foreign products and pending purchases, and swallows verify failures (retried next launch)', async () => {
    const f = fakeIap();
    const d = deps(f.iap);
    startPurchaseRecovery(d);
    await settle();
    f.emit(applePurchase({ productId: 'com.other.sub' }));
    f.emit(applePurchase({ purchaseState: 'pending' }));
    await settle();
    expect(d.api.verifyApple).not.toHaveBeenCalled();
    d.api.verifyApple.mockRejectedValue(new Error('offline'));
    f.emit(applePurchase());
    await settle();
    expect(f.iap.finishTransaction).not.toHaveBeenCalled();
  });

  it('does nothing without the native module', () => {
    expect(() => startPurchaseRecovery(deps(null))()).not.toThrow();
  });
});

describe('store country, prices and manage', () => {
  it('converts the StoreKit alpha-3 storefront to alpha-2 for X-Store-Country', async () => {
    const f = fakeIap();
    const d = deps(f.iap);
    expect(await initStoreCountry(d)).toBe('US');
    expect(d.setCountry).toHaveBeenCalledWith('US');
  });

  it('stays ZZ when the store is unavailable or errors', async () => {
    expect(await initStoreCountry(deps(null))).toBe('ZZ');
    const f = fakeIap();
    f.iap.initConnection.mockRejectedValue(new Error('no store'));
    expect(await initStoreCountry(deps(f.iap))).toBe('ZZ');
  });

  it('reads the store-localized Apple prices by interval and size', async () => {
    const f = fakeIap({ products: [{ id: 'rootaroo.hh5.month', displayPrice: '€8,99' }, { id: 'rootaroo.hh5.year', displayPrice: '€79,99' }] });
    expect(await fetchStorePrices(deps(f.iap))).toEqual({ 'month:5': '€8,99', 'year:5': '€79,99' });
  });

  it('reads the Google base plan prices', async () => {
    const f = fakeIap({ products: [{ id: 'rootaroo.hh6', subscriptionOffers: [{ basePlanIdAndroid: 'month', displayPrice: '£10.99' }, { basePlanIdAndroid: 'year', displayPrice: '£109.99' }] }] });
    expect(await fetchStorePrices(deps(f.iap, { provider: () => 'google' }))).toEqual({ 'month:6': '£10.99', 'year:6': '£109.99' });
  });

  it('returns no prices (the server USD matrix shows) when the store fails', async () => {
    const f = fakeIap();
    f.iap.fetchProducts.mockRejectedValue(new Error('x'));
    expect(await fetchStorePrices(deps(f.iap))).toEqual({});
  });

  it('manage deep-links to the store with the Google sku, and falls back to the web page', async () => {
    const f = fakeIap();
    const d = deps(f.iap);
    await manageStoreSubscription('google', { seats: 8, interval: 'month' }, d);
    expect(f.iap.deepLinkToSubscriptions).toHaveBeenCalledWith({ skuAndroid: 'rootaroo.hh8', packageNameAndroid: 'com.rootaroo.app' });
    f.iap.deepLinkToSubscriptions.mockRejectedValue(new Error('no activity'));
    await manageStoreSubscription('apple', { seats: 8, interval: 'month' }, d);
    expect(d.openUrl).toHaveBeenCalledWith('https://apps.apple.com/account/subscriptions');
    await manageStoreSubscription('google', { seats: 8, interval: 'month' }, deps(null));
  });
});
