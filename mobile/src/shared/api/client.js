import axios from 'axios';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useAuthStore } from '../store/authStore';

// Expo's dev client already knows a reachable host for this machine — it just
// downloaded the JS bundle from it. Deriving the API host from it means a
// changed LAN IP (Wi-Fi reconnect, DHCP renewal) doesn't require hand-editing
// .env and rebuilding; the app just follows wherever Metro currently is.
function getDevServerHost() {
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.43:8081"
  if (!hostUri) return null;
  return hostUri.split(':')[0] || null;
}

const devHost = getDevServerHost();

const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  Constants.expoConfig?.extra?.apiBaseUrl ||
  (devHost ? `http://${devHost}:3000/api/v1` : null) ||
  (Platform.OS === 'android' && !Constants.isDevice
    ? 'http://10.0.2.2:3000/api/v1'
    : 'http://localhost:3000/api/v1');

if (__DEV__) {
  console.log('[apiClient] BASE_URL:', BASE_URL);
}

const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    // Prevent Express ETag 304 responses (axios treats 304 as a non-2xx error,
    // which silently breaks vault key lookups and document listing).
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
  validateStatus: (status) => status >= 200 && status < 400, // accept 304
});

/**
 * Trades a refresh token for a fresh pair. Bypasses `apiClient` (it can't
 * carry an Authorization header that's mid-refresh), hence the explicit
 * timeout. Shared by the 401 interceptor below and by `restoreSession`,
 * which refreshes up front on a cold start instead of letting every
 * first-screen request 401 and retry.
 */
export async function requestTokenRefresh(refreshToken, timeout = 15000) {
  const { data } = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken }, { timeout });
  return data.data;
}

// ── Refresh-token mutex ──
let isRefreshing = false;
let refreshQueue = [];

function onRefreshed(newToken) {
  refreshQueue.forEach((q) => q.resolve(newToken));
  refreshQueue = [];
}

function onRefreshFailed(error) {
  refreshQueue.forEach((q) => q.reject(error));
  refreshQueue = [];
}

// ── Billing hooks ──
// A 402 from any guarded route means entitlement changed server-side; the
// billing store registers a single-flight refresh here (no import cycle).
let paymentRequiredHandler = null;

export function setPaymentRequiredHandler(fn) {
  paymentRequiredHandler = fn;
}

// Routing (spec §12): which purchase flow the server offers depends on the
// platform and store country. The IAP module sets the storefront country once
// the store connection reports it; until then (and on web) it is ZZ.
let storeCountry = 'ZZ';

export function setStoreCountry(code) {
  storeCountry = /^[A-Z]{2}$/.test(code) ? code : 'ZZ';
}

export function platformHeaders() {
  return {
    'X-Platform': Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    'X-Store-Country': storeCountry,
  };
}

apiClient.interceptors.request.use(
  (config) => {
    const token = useAuthStore.getState().accessToken;
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    if (config.headers) {
      // Lets the server bucket "today" in the household's own timezone
      // instead of its own (see dashboard streak/activity) — cheap to send
      // on every request, and harmless where the server doesn't use it yet.
      try {
        config.headers['X-Timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        /* Intl unavailable — server falls back to the household's stored zone */
      }
      Object.entries(platformHeaders()).forEach(([k, v]) => { config.headers[k] = v; });
    }
    return config;
  },
  (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 402 && paymentRequiredHandler) {
      try { paymentRequiredHandler(error.response.data); } catch { /* never block the original rejection */ }
    }
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        // Another request is already refreshing — queue this one
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (newToken) => {
              if (original.headers) {
                original.headers.Authorization = `Bearer ${newToken}`;
              }
              resolve(apiClient(original));
            },
            reject,
          });
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = useAuthStore.getState().refreshToken;
        if (!refreshToken) {
          useAuthStore.getState().logout();
          return Promise.reject(error);
        }
        // requestTokenRefresh carries its own timeout — without one, a
        // hung/slow refresh never settles, `isRefreshing` never clears, and
        // every queued request above hangs forever with it.
        const { accessToken, refreshToken: newRefresh } = await requestTokenRefresh(refreshToken);
        useAuthStore.getState().setAuth(useAuthStore.getState().user, accessToken, newRefresh);
        if (original.headers) original.headers.Authorization = `Bearer ${accessToken}`;
        onRefreshed(accessToken);
        return apiClient(original);
      } catch (refreshError) {
        onRefreshFailed(refreshError);
        useAuthStore.getState().logout();
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  },
);

export default apiClient;
