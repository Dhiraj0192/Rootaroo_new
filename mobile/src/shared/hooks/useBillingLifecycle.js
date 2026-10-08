import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useBillingStore } from '../store/billingStore';
import { initStoreCountry, startPurchaseRecovery } from '../billing/iap';

/** Section 7.4: status on launch and on every return to the foreground. */
export function useBillingLifecycle(isAuthenticated, userId) {
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    useBillingStore.getState().hydrate(userId).then(() => useBillingStore.getState().refresh());
  }, [isAuthenticated, userId]);

  // Storefront country feeds routing (X-Store-Country); recovery finishes purchases the app was interrupted on.
  useEffect(() => {
    if (!isAuthenticated || !userId) return undefined;
    initStoreCountry().then((country) => { if (country !== 'ZZ') useBillingStore.getState().refresh(); });
    return startPurchaseRecovery();
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') useBillingStore.getState().refresh();
    });
    return () => sub.remove();
  }, [isAuthenticated]);
}
