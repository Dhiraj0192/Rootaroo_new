import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { billingApi } from '../api/billing';
import { setPaymentRequiredHandler } from '../api/client';

export const BILLING_STORAGE_KEY = 'rootaroo_billing_status_v1';

let inflight = null;
// Bumped by reset() so a response that lands after sign-out is discarded.
let epoch = 0;

export const useBillingStore = create((set, get) => ({
  status: null,
  userId: null,
  lastFetchedAt: null,
  error: null,
  noHousehold: false,

  // Last-known status from disk, so a cold start offline keeps the same gate.
  hydrate: async (userId) => {
    set({ userId });
    try {
      const raw = await AsyncStorage.getItem(BILLING_STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.userId === userId && !get().status) set({ status: saved.status, lastFetchedAt: saved.at });
    } catch {
      /* unreadable cache: wait for the network */
    }
  },

  // Single-flight: concurrent callers (a burst of 402s) share one request.
  refresh: () => {
    if (inflight) return inflight;
    const myEpoch = epoch;
    inflight = (async () => {
      try {
        const status = await billingApi.getStatus();
        if (myEpoch !== epoch) return null;
        const at = Date.now();
        set({ status, lastFetchedAt: at, error: null, noHousehold: false });
        AsyncStorage.setItem(BILLING_STORAGE_KEY, JSON.stringify({ userId: get().userId, status, at })).catch(() => {});
        return status;
      } catch (e) {
        if (myEpoch !== epoch) return null;
        if (e?.response?.status === 403 && e?.response?.data?.code === 'NO_HOUSEHOLD') {
          set({ status: null, noHousehold: true, error: null });
          return null;
        }
        // Network errors never change the gate: keep the last-known status.
        set({ error: e?.message || 'network' });
        return get().status;
      } finally {
        if (myEpoch === epoch) inflight = null;
      }
    })();
    return inflight;
  },

  applySync: (sync) => {
    const { status } = get();
    if (!status || !sync) return;
    set({
      status: {
        ...status,
        entitlement: sync.entitlement,
        pendingCheckout: sync.pendingCheckout && sync.pendingCheckout.state !== 'complete' ? sync.pendingCheckout : null,
      },
    });
  },

  reset: () => {
    epoch += 1;
    inflight = null;
    set({ status: null, userId: null, lastFetchedAt: null, error: null, noHousehold: false });
    AsyncStorage.removeItem(BILLING_STORAGE_KEY).catch(() => {});
  },
}));

export function selectGate(state) {
  const s = state.status;
  if (!s || !s.entitlement) return 'unknown';
  if (!s.entitlement.allowed) return 'blocked';
  return s.entitlement.reason === 'grace' ? 'grace' : 'allowed';
}

setPaymentRequiredHandler(() => {
  useBillingStore.getState().refresh();
});
