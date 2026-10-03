import { Linking, Platform } from 'react-native';
import { billingApi } from '../api/billing';
import { useBillingStore } from '../store/billingStore';
import { toAlpha2 } from './countries';
import { STORE_SUBSCRIPTION_URLS } from './legalLinks';

// expo-iap is a native module: it only exists in a dev-client / production build that was built with it
// (spec section 16; needs a new EAS build). Expo Go, web and older builds load without it and fall back.
let nativeIap = null;
try {
  // eslint-disable-next-line global-require
  nativeIap = require('expo-iap');
} catch {
  nativeIap = null;
}

export const PACKAGE_NAME = 'com.rootaroo.app';
const SIZES = [5, 6, 7, 8, 9, 10];
const INTERVALS = ['month', 'year'];
const OUR_SKU = /^rootaroo\.hh(10|[5-9])(\.(month|year))?$/;
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;

export const defaultIapDeps = {
  iap: nativeIap,
  api: billingApi,
  provider: () => (Platform.OS === 'ios' ? 'apple' : Platform.OS === 'android' ? 'google' : null),
  householdId: () => useBillingStore.getState().status?.householdId ?? null,
  refreshStatus: () => useBillingStore.getState().refresh(),
  openUrl: (url) => Linking.openURL(url),
  // Lazy: the api client pulls in the auth store, which this module must not load at import time.
  // eslint-disable-next-line global-require
  setCountry: (code) => require('../api/client').setStoreCountry(code),
};

export function iapAvailable(deps = defaultIapDeps) {
  return Boolean(deps.iap && typeof deps.iap.initConnection === 'function' && deps.provider());
}

export const isOurSku = (productId) => OUR_SKU.test(productId || '');

/** Apple: one product per size and interval. Google: one subscription per size, with month/year base plans. */
export function skuFor(provider, seats, interval) {
  return provider === 'apple' ? `rootaroo.hh${seats}.${interval}` : `rootaroo.hh${seats}`;
}

export function allSkus(provider) {
  return provider === 'apple'
    ? SIZES.flatMap((n) => INTERVALS.map((i) => skuFor('apple', n, i)))
    : SIZES.map((n) => skuFor('google', n, 'month'));
}

let connecting = null;
// True while purchaseSubscription owns the purchase listener, so recovery does not verify the same purchase twice.
let flowActive = false;

export function __resetIapForTests() {
  connecting = null;
  flowActive = false;
}

function connect(deps) {
  if (!connecting) {
    connecting = Promise.resolve(deps.iap.initConnection()).catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

/** Storefront country for routing (X-Store-Country). Safe to call on every launch; failures leave "ZZ". */
export async function initStoreCountry(deps = defaultIapDeps) {
  if (!iapAvailable(deps)) return 'ZZ';
  try {
    await connect(deps);
    const code = toAlpha2(await deps.iap.getStorefront());
    deps.setCountry(code);
    return code;
  } catch {
    return 'ZZ';
  }
}

/** The store's own localized prices, keyed "month:5". Missing products are simply absent. */
export async function fetchStorePrices(deps = defaultIapDeps) {
  const provider = deps.provider();
  if (!iapAvailable(deps)) return {};
  try {
    await connect(deps);
    const products = await deps.iap.fetchProducts({ skus: allSkus(provider), type: 'subs' });
    const out = {};
    for (const p of products || []) {
      if (provider === 'apple') {
        const m = /^rootaroo\.hh(\d+)\.(month|year)$/.exec(p.id);
        if (m) out[`${m[2]}:${m[1]}`] = p.displayPrice;
      } else {
        const m = /^rootaroo\.hh(\d+)$/.exec(p.id);
        if (!m) continue;
        for (const interval of INTERVALS) {
          const offer = (p.subscriptionOffers || []).find((o) => o.basePlanIdAndroid === interval && !(o.offerTagsAndroid || []).length && o.paymentMode == null);
          if (offer) out[`${interval}:${m[1]}`] = offer.displayPrice;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function androidOfferToken(deps, sku, interval) {
  const products = await deps.iap.fetchProducts({ skus: [sku], type: 'subs' });
  const offers = products?.[0]?.subscriptionOffers || [];
  const base = offers.filter((o) => o.basePlanIdAndroid === interval);
  const offer = base.find((o) => o.paymentMode == null) || base[0];
  return offer?.offerTokenAndroid || null;
}

export const PURCHASE_ERRORS = {
  unavailable: { title: 'Not available', message: "Purchasing isn't available on this device right now." },
  generic: { title: 'Something went wrong', message: 'Please try again.' },
  mismatch: { title: 'Different household', message: 'This purchase belongs to a different household.' },
  network: { title: 'Could not confirm', message: 'We could not confirm your purchase yet. Check your connection; we will keep trying.' },
};

export function describeIapError(err) {
  const data = err?.response?.data || {};
  if (data.code === 'PURCHASE_HOUSEHOLD_MISMATCH') return PURCHASE_ERRORS.mismatch;
  if (data.code === 'BILLING_MODE_UNAVAILABLE') return PURCHASE_ERRORS.unavailable;
  if (!err?.response) return PURCHASE_ERRORS.network;
  return PURCHASE_ERRORS.generic;
}

function waitForPurchase(iap, sku, timeoutMs = FLOW_TIMEOUT_MS) {
  let finish;
  const promise = new Promise((resolve) => {
    let updated;
    let failed;
    const timer = setTimeout(() => finish({ error: { code: 'timeout' } }), timeoutMs);
    finish = (value) => {
      clearTimeout(timer);
      updated?.remove?.();
      failed?.remove?.();
      resolve(value);
    };
    updated = iap.purchaseUpdatedListener((purchase) => { if (purchase.productId === sku) finish({ purchase }); });
    failed = iap.purchaseErrorListener((error) => finish({ error }));
  });
  return { promise, cancel: () => finish({ cancelled: true }) };
}

/** Sends the signed transaction (Apple JWS) or purchase token (Google) for server verification. */
export async function verifyOnServer(purchase, deps = defaultIapDeps) {
  const provider = deps.provider();
  if (provider === 'apple') return deps.api.verifyApple(purchase.purchaseToken);
  return deps.api.verifyGoogle({ purchaseToken: purchase.purchaseToken, productId: purchase.productId });
}

async function finalize(purchase, deps) {
  if (purchase.purchaseState === 'pending') return { outcome: 'pending', status: await deps.refreshStatus() };
  try {
    await verifyOnServer(purchase, deps);
  } catch (err) {
    // Not finishing the transaction keeps it in the store queue: iOS replays it on the next launch and Google
    // refunds only after 3 days, so a failed verify never loses the purchase.
    return { outcome: 'error', error: describeIapError(err) };
  }
  await Promise.resolve(deps.iap.finishTransaction({ purchase, isConsumable: false })).catch(() => {});
  const status = await deps.refreshStatus();
  return { outcome: status?.entitlement?.allowed ? 'unlocked' : 'confirming', status };
}

/**
 * Task 11.5: the in-app counterpart of startStripeCheckout. Same outcomes
 * ('unlocked' | 'confirming' | 'not_completed' | 'pending' | 'error'), so the screens treat both alike.
 */
export async function purchaseSubscription({ interval, seats }, deps = defaultIapDeps) {
  if (!iapAvailable(deps)) return { outcome: 'error', error: PURCHASE_ERRORS.unavailable };
  const provider = deps.provider();
  const householdId = deps.householdId();
  if (!householdId) return { outcome: 'error', error: PURCHASE_ERRORS.generic };
  const sku = skuFor(provider, seats, interval);
  let request;
  try {
    await connect(deps);
    if (provider === 'apple') {
      request = { apple: { sku, appAccountToken: householdId } };
    } else {
      const offerToken = await androidOfferToken(deps, sku, interval);
      if (!offerToken) return { outcome: 'error', error: PURCHASE_ERRORS.unavailable };
      request = { google: { skus: [sku], obfuscatedAccountId: householdId, subscriptionOffers: [{ sku, offerToken }] } };
    }
  } catch {
    return { outcome: 'error', error: PURCHASE_ERRORS.unavailable };
  }

  flowActive = true;
  const waiting = waitForPurchase(deps.iap, sku);
  try {
    try {
      await deps.iap.requestPurchase({ type: 'subs', request });
    } catch (err) {
      waiting.cancel();
      return mapPurchaseError(err);
    }
    const result = await waiting.promise;
    if (result.error) return mapPurchaseError(result.error);
    if (result.cancelled) return { outcome: 'not_completed' };
    return await finalize(result.purchase, deps);
  } finally {
    flowActive = false;
  }
}

function mapPurchaseError(err) {
  const code = err?.code;
  if (code === 'user-cancelled') return { outcome: 'not_completed' };
  if (code === 'deferred-payment') return { outcome: 'pending' };
  if (code === 'already-owned') return { outcome: 'already_owned' };
  return { outcome: 'error', error: code === 'network-error' ? PURCHASE_ERRORS.network : PURCHASE_ERRORS.generic };
}

/**
 * Restore purchases: re-reads the store's entitlements and sends each of ours to the server. A purchase made by
 * another household answers 409 and is skipped.
 */
export async function restoreStorePurchases(deps = defaultIapDeps) {
  if (!iapAvailable(deps)) return { outcome: 'error', error: PURCHASE_ERRORS.unavailable };
  try {
    await connect(deps);
    await Promise.resolve(deps.iap.restorePurchases?.()).catch(() => {});
    const purchases = (await deps.iap.getAvailablePurchases()) || [];
    const ours = purchases.filter((p) => isOurSku(p.productId) && p.purchaseToken && p.purchaseState !== 'pending');
    let verified = 0;
    let lastError = null;
    for (const purchase of ours) {
      try {
        await verifyOnServer(purchase, deps);
        await Promise.resolve(deps.iap.finishTransaction({ purchase, isConsumable: false })).catch(() => {});
        verified += 1;
      } catch (err) {
        lastError = err;
      }
    }
    const status = await deps.refreshStatus();
    if (status?.entitlement?.allowed) return { outcome: 'unlocked', status, verified };
    if (verified > 0) return { outcome: 'confirming', status, verified };
    if (lastError) return { outcome: 'error', error: describeIapError(lastError), status };
    return { outcome: 'nothing_to_restore', status };
  } catch {
    return { outcome: 'error', error: PURCHASE_ERRORS.generic };
  }
}

/**
 * Purchases that arrive outside a purchase flow (interrupted verification, Ask to Buy approved later, a renewal
 * the app learns about at launch) are verified and finished here. Returns a cleanup function.
 */
export function startPurchaseRecovery(deps = defaultIapDeps) {
  if (!iapAvailable(deps)) return () => {};
  let sub = null;
  let stopped = false;
  connect(deps).then(() => {
    if (stopped) return;
    sub = deps.iap.purchaseUpdatedListener(async (purchase) => {
      if (flowActive || !isOurSku(purchase.productId) || purchase.purchaseState === 'pending' || !purchase.purchaseToken) return;
      try {
        await verifyOnServer(purchase, deps);
        await Promise.resolve(deps.iap.finishTransaction({ purchase, isConsumable: false })).catch(() => {});
        await deps.refreshStatus();
      } catch {
        /* stays in the store queue; retried on the next launch */
      }
    });
  }).catch(() => {});
  return () => { stopped = true; sub?.remove?.(); };
}

/** Opens the store's own subscription management page for this subscription. */
export async function manageStoreSubscription(provider, { seats, interval } = {}, deps = defaultIapDeps) {
  if (deps.iap?.deepLinkToSubscriptions) {
    try {
      await deps.iap.deepLinkToSubscriptions({ skuAndroid: seats ? skuFor('google', seats, interval) : undefined, packageNameAndroid: PACKAGE_NAME });
      return;
    } catch {
      /* fall through to the web page */
    }
  }
  await deps.openUrl(STORE_SUBSCRIPTION_URLS[provider === 'apple' ? 'apple' : 'google']);
}
