import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import { MAX_SHARE_MINUTES } from './sharePresets';

export const LOCATION_SHARE_TASK = 'rootaroo-location-share';
export const ACTIVE_SHARE_KEY = 'rootaroo.activeLocationShare';

// Required lazily so importing this module (the app entry does, to register the task) stays cheap and test-safe.
const defaultDeps = {
  get Location() { return require('expo-location'); },
  get api() { return require('../api/locationShares').locationSharesApi; },
  now: () => Date.now(),
  explainBackground: () => explainBackground(),
};

// Shown before the phone's own "Allow all the time" prompt: Play's prominent-disclosure
// rule, and our privacy policy, promise this explanation comes first.
export const BACKGROUND_NOTICE = {
  title: 'Keep sharing while Rootaroo is closed?',
  body: 'Next, your phone asks whether Rootaroo may use your location all the time. If you allow it, Rootaroo keeps sending your location in the background, even when the app is closed, only to the people you chose. It stops when the timer ends or when you stop sharing.',
};

/** Resolves true to go on to the permission prompt, false for "Not now". */
export function explainBackground() {
  const { showAlert, canShowAlert } = require('../services/themedAlert');
  if (!canShowAlert()) return Promise.resolve(true);
  return new Promise((resolve) => {
    showAlert(BACKGROUND_NOTICE.title, BACKGROUND_NOTICE.body, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ]);
  });
}

/** Explains background sharing first, unless it's already allowed or the phone won't ask again. */
async function mayAskForBackground(deps) {
  const current = await deps.Location.getBackgroundPermissionsAsync?.();
  if (current?.status === 'granted') return true;
  if (current?.canAskAgain === false) return true; // no prompt will show, so there is nothing to explain
  return (deps.explainBackground ?? defaultDeps.explainBackground)();
}

async function readActive() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_SHARE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Local teardown only: the server side is already ended, or is the caller's job.
export async function stopTracking({ Location } = defaultDeps) {
  await AsyncStorage.removeItem(ACTIVE_SHARE_KEY).catch(() => {});
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_SHARE_TASK);
  } catch {
    // not running
  }
}

export async function handleLocationTask({ data, error } = {}, deps = defaultDeps) {
  if (error) return;
  try {
    const active = await readActive();
    if (!active || new Date(active.expiresAt).getTime() <= deps.now()) {
      await stopTracking(deps);
      return;
    }
    const locations = data?.locations;
    const last = locations?.[locations.length - 1];
    if (!last) return;
    const { latitude, longitude, accuracy } = last.coords;
    try {
      await deps.api.updateLocation(active.id, { latitude, longitude, accuracy });
    } catch (e) {
      if (e?.response?.status === 410) await stopTracking(deps);
    }
  } catch {
    // a missed update is fine, the next one retries
  }
}

// Tracks an existing share: background updates when "Always" is granted, otherwise the caller runs the foreground loop.
export async function attachSharing(share, deps = defaultDeps) {
  const { Location } = deps;
  await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: share.id, expiresAt: share.expiresAt }));
  try {
    if (!(await mayAskForBackground(deps))) return { mode: 'foreground' };
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return { mode: 'foreground' };
    await Location.startLocationUpdatesAsync(LOCATION_SHARE_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      timeInterval: 60_000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Sharing location with family',
        notificationBody: 'Rootaroo is sharing your location until the timer ends. Open the app to stop.',
      },
    });
    return { mode: 'background' };
  } catch {
    return { mode: 'foreground' };
  }
}

export async function startSharing({ durationMinutes, viewerIds }, deps = defaultDeps) {
  const { Location, api } = deps;
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') throw new Error('Location permission is needed to share');
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const share = await api.create({
    durationMinutes: Math.min(Math.max(1, Math.round(durationMinutes)), MAX_SHARE_MINUTES),
    viewerIds: viewerIds ?? null,
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  });
  const { mode } = await attachSharing(share, deps);
  return { share, mode };
}

export async function stopSharing(deps = defaultDeps) {
  const active = await readActive();
  if (active) await deps.api.stop(active.id).catch(() => {});
  await stopTracking(deps);
}

export async function getActiveShare() {
  return readActive();
}

try {
  TaskManager.defineTask(LOCATION_SHARE_TASK, (body) => handleLocationTask(body, defaultDeps));
} catch {
  // TaskManager is unavailable (tests, web)
}
