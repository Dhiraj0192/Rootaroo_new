import { create } from 'zustand';
import { saveTokens, saveHouseholdId, loadTokens, clearTokens } from './authPersist';
import {
  clearSignupProgress,
  loadSignupProgress,
} from './signupProgress';
import apiClient, { requestTokenRefresh } from '../api/client';
import { warmScreenCache, clearScreenCache, clearSharedRequests } from '../cache/screenCache';
import { prefetchHome } from '../cache/homePrefetch';
import { useFeedStore } from './feedStore';
import { unregisterPushNotificationsAsync } from '../pushNotifications';

// Access tokens live 15 minutes, so almost every cold start finds an
// expired one. Refreshing during the splash beats letting the first
// screen's dozen requests all 401, refresh, and retry.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
// Kept short so a dead connection doesn't hold the splash; on a timeout
// the stored tokens are used and the 401 interceptor refreshes later.
const RESTORE_REFRESH_TIMEOUT_MS = 8000;

function accessTokenExpiresSoon(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return typeof exp === 'number' && exp * 1000 - Date.now() < TOKEN_EXPIRY_MARGIN_MS;
  } catch {
    // Unreadable token: leave it to the interceptor rather than guess.
    return false;
  }
}

export const useAuthStore = create((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: true,
  householdId: null,
  signupProgress: null,
  celebrate: false,
  showTour: false,
  showFeedTour: false,
  showChatTour: false,
  showTasksTour: false,
  showMoreTour: false,

  setAuth: (user, accessToken, refreshToken) => {
    set({ user, accessToken, refreshToken, isAuthenticated: true, isLoading: false });
    warmScreenCache(user?.id);
    saveTokens(accessToken, refreshToken, user).catch(() => {});
  },

  setAuthPending: (user, accessToken, refreshToken) => {
    set({ user, accessToken, refreshToken, isAuthenticated: false, isLoading: false });
    // Persist so kill-app mid-setup can resume
    saveTokens(accessToken, refreshToken, user).catch(() => {});
  },

  setUser: (user) => {
    set({ user });
    const { accessToken, refreshToken } = get();
    if (accessToken && refreshToken) {
      saveTokens(accessToken, refreshToken, user).catch(() => {});
    }
  },

  setLoading: (isLoading) => set({ isLoading }),

  setHousehold: (householdId) => {
    set({ householdId });
    saveHouseholdId(householdId).catch(() => {});
  },

  setSignupProgress: (signupProgress) => set({ signupProgress }),

  logout: () => {
    // Unregister this device's push token with the outgoing session's token —
    // by the time any effect reacts to the sign-out, it's already cleared.
    const { accessToken } = get();
    if (accessToken) unregisterPushNotificationsAsync(accessToken);
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      householdId: null,
      signupProgress: null,
    });
    clearTokens().catch(() => {});
    clearSignupProgress().catch(() => {});
    clearSharedRequests();
    clearScreenCache();
    // Lazy require: billingStore → api → client → authStore would be a cycle at import time.
    try { require('./billingStore').useBillingStore.getState().reset(); } catch { /* not loaded yet */ }
    useFeedStore.setState({ posts: [], cursor: null, hasMore: true, lastFetchedAt: null });
  },

  // Fresh account finishing onboarding fires a one-time confetti burst on
  // the first Home screen it lands on; returning logins skip it.
  triggerCelebration: () => set({ celebrate: true }),
  clearCelebration: () => set({ celebrate: false }),

  // Same one-time-per-fresh-signup trigger as celebrate — the app tour
  // popup shown the first time a new account lands on Home.
  triggerTour: () => set({ showTour: true }),
  dismissTour: () => set({ showTour: false }),

  // Guided chain: each screen's tour ends with a "Continue to X" button
  // (see TourTooltip's continueLabel/onContinue) that navigates to the next
  // screen and triggers its one-shot tour directly.
  triggerFeedTour: () => set({ showFeedTour: true }),
  dismissFeedTour: () => set({ showFeedTour: false }),
  triggerChatTour: () => set({ showChatTour: true }),
  dismissChatTour: () => set({ showChatTour: false }),
  triggerTasksTour: () => set({ showTasksTour: true }),
  dismissTasksTour: () => set({ showTasksTour: false }),
  triggerMoreTour: () => set({ showMoreTour: true }),
  dismissMoreTour: () => set({ showMoreTour: false }),

  completeSetup: () => {
    const { accessToken, refreshToken, user } = get();
    set({ isAuthenticated: true, isLoading: false, signupProgress: null });
    warmScreenCache(user?.id);
    clearSignupProgress().catch(() => {});
    if (accessToken && refreshToken && user) {
      saveTokens(accessToken, refreshToken, user).catch(() => {});
    }
  },

  restoreSession: async () => {
    try {
      const [{ accessToken, refreshToken, user, householdId }, progress] = await Promise.all([
        loadTokens(),
        loadSignupProgress(),
      ]);

      const incomplete =
        !!progress &&
        !progress.setupComplete &&
        progress.step !== 'done';

      // Incomplete signup must not sticky-resume across restarts/rebuilds.
      // SecureStore survives rebuilds; clearing avoids opening mid-wizard (e.g. step 1).
      // In-session wizard navigation still works via navigation.replace.
      if (incomplete) {
        await Promise.all([clearTokens(), clearSignupProgress()]);
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          isLoading: false,
          householdId: null,
          signupProgress: null,
        });
        return;
      }

      if (accessToken && refreshToken && user) {
        let tokens = { accessToken, refreshToken };
        // Read last session's screen data off disk while the token is refreshed.
        const cacheWarm = warmScreenCache(user.id);
        if (accessTokenExpiresSoon(accessToken)) {
          try {
            tokens = await requestTokenRefresh(refreshToken, RESTORE_REFRESH_TIMEOUT_MS);
            saveTokens(tokens.accessToken, tokens.refreshToken, user).catch(() => {});
          } catch (e) {
            // Server rejected the refresh token (revoked/expired): same
            // outcome the interceptor would reach, minus the failed requests.
            if (e?.response?.status === 401) {
              get().logout();
              return;
            }
          }
        }
        await cacheWarm;
        set({
          user,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          isAuthenticated: true,
          isLoading: false,
          householdId: householdId ?? null,
          signupProgress: null,
        });
        prefetchHome(householdId);

        apiClient
          .get('/households')
          .then((r) => {
            if (r.data.data.length > 0) {
              const id = r.data.data[0].id;
              set({ householdId: id });
              saveHouseholdId(id).catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        set({ isLoading: false, signupProgress: null });
      }
    } catch {
      set({ isLoading: false });
    }
  },
}));
