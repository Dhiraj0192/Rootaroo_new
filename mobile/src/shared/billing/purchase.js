import * as WebBrowser from 'expo-web-browser';
import { billingApi } from '../api/billing';
import { useBillingStore } from '../store/billingStore';
import { purchaseSubscription, restoreStorePurchases } from './iap';

export const RETURN_URL = 'rootaroo://billing';
const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 30000;

export const defaultDeps = {
  api: billingApi,
  openAuthSession: (url, returnUrl) => WebBrowser.openAuthSessionAsync(url, returnUrl),
  openBrowser: (url) => WebBrowser.openBrowserAsync(url),
  refreshStatus: () => useBillingStore.getState().refresh(),
  applySync: (sync) => useBillingStore.getState().applySync(sync),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function pollUntilSettled(deps, timeoutMs = POLL_FOR_MS, everyMs = POLL_EVERY_MS) {
  const end = deps.now() + timeoutMs;
  let last = null;
  while (deps.now() < end) {
    last = await deps.refreshStatus();
    if (last?.entitlement?.allowed) return last;
    await deps.sleep(everyMs);
  }
  return last;
}

/**
 * §8.2: open hosted Checkout, then ALWAYS sync by sessionId, whatever the browser
 * reported (Android often says "dismiss" after a successful payment).
 */
export async function startStripeCheckout({ interval, seats }, deps = defaultDeps) {
  let created;
  try {
    created = await deps.api.createCheckout({ interval, seats });
  } catch (err) {
    return { outcome: 'error', status: null, error: describeCheckoutError(err) };
  }
  let result = { type: 'dismiss' };
  try {
    result = await deps.openAuthSession(created.url, RETURN_URL);
  } catch {
    /* treat as dismiss; the sync below decides */
  }
  let sync = null;
  try {
    sync = await deps.api.syncCheckout(created.sessionId);
    deps.applySync(sync);
  } catch {
    /* the webhook or the 15-minute sweep will catch up (T3) */
  }
  if (sync?.entitlement?.allowed) return { outcome: 'unlocked', status: await deps.refreshStatus() };
  if (sync?.pendingCheckout?.state === 'processing') {
    const status = await pollUntilSettled(deps);
    return { outcome: status?.entitlement?.allowed ? 'unlocked' : 'confirming', status };
  }
  const status = await deps.refreshStatus();
  if (status?.entitlement?.allowed) return { outcome: 'unlocked', status };
  return { outcome: result.type === 'success' ? 'confirming' : 'not_completed', status };
}

export const STORE_METHODS = ['apple_iap', 'google_play'];

/** Whether the server's purchaseMethod is something this build can start. */
export const canStartPurchase = (method) => method === 'stripe_checkout' || STORE_METHODS.includes(method);

/**
 * Section 12 routing in the app: dispatch on the server-chosen purchaseMethod. Every flow resolves to the same
 * outcomes ('unlocked' | 'confirming' | 'not_completed' | 'pending' | 'error') so the screens stay provider-agnostic.
 */
export async function startPurchase({ method, interval, seats }, deps = defaultDeps, iapDeps) {
  if (STORE_METHODS.includes(method)) {
    const r = await purchaseSubscription({ interval, seats }, iapDeps);
    // The store says this Apple/Google account already owns it: attach it to the household instead of buying again.
    if (r.outcome === 'already_owned') return restoreStorePurchases(iapDeps);
    return r;
  }
  if (method === 'stripe_checkout') return startStripeCheckout({ interval, seats }, deps);
  return { outcome: 'error', status: null, error: describeCheckoutError({ response: { data: { code: 'PURCHASE_METHOD_MISMATCH' } } }) };
}

/** Restore purchases: re-verifies the store's entitlements for IAP, a plain status refresh otherwise. */
export async function restorePurchases({ method }, deps = defaultDeps, iapDeps) {
  if (STORE_METHODS.includes(method)) return restoreStorePurchases(iapDeps);
  return { outcome: 'refreshed', status: await deps.refreshStatus() };
}

export async function openBillingPortal(deps = defaultDeps) {
  const { url } = await deps.api.openPortal();
  try { await deps.openAuthSession(url, RETURN_URL); } catch { /* ignore */ }
  return deps.refreshStatus();
}

export function describeCheckoutError(err) {
  const data = err?.response?.data || {};
  switch (data.code) {
    case 'ALREADY_SUBSCRIBED':
      return { title: 'Already subscribed', message: 'Your household already has a subscription. Pull to refresh.' };
    case 'PAYMENT_ISSUE':
      return { title: 'Payment problem', message: 'Your last payment failed. Update your payment method to continue.', portalUrl: data.portalUrl || null };
    case 'SEATS_BELOW_MEMBERS':
      return { title: 'Choose a bigger plan', message: `Your household has ${data.memberCount} members. Choose a plan with at least that many.` };
    case 'PURCHASE_METHOD_MISMATCH':
      return { title: 'Not available', message: "Purchasing isn't available here yet." };
    case 'BILLING_MODE_UNAVAILABLE':
      return { title: 'Not available', message: "Purchasing isn't available right now. Please try again later." };
    case 'LOCK_BUSY':
      return { title: 'One moment', message: 'Another purchase is in progress. Try again in a moment.' };
    default:
      return { title: 'Something went wrong', message: err?.response ? 'Please try again.' : 'Check your connection and try again.' };
  }
}
