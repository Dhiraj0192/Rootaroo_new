import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';

export const DEVICE_ID_KEY = 'rootaroo_device_id';

let deviceId = null;
let loading = null;

export function loadDeviceId() {
  if (!loading) {
    loading = (async () => {
      try {
        const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
        if (stored) {
          deviceId = stored;
          return stored;
        }
        deviceId = Crypto.randomUUID();
        try {
          await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
        } catch {
          /* keep the in-memory id for this session */
        }
        return deviceId;
      } catch {
        deviceId = deviceId ?? Crypto.randomUUID();
        return deviceId;
      }
    })();
  }
  return loading;
}

export function deviceHeaders() {
  const headers = {
    'X-Device-Id': deviceId,
    'X-Device-Name': Constants.deviceName,
    'X-App-Version': Constants.expoConfig?.version,
  };
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null));
}

export function __resetDeviceInfoForTests() {
  deviceId = null;
  loading = null;
}
