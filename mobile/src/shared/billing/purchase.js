import * as WebBrowser from 'expo-web-browser';
import { billingApi } from '../api/billing';
import { useBillingStore } from '../store/billingStore';

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
