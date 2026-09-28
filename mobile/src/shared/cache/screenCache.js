import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Last-loaded data for the main screens (Home, Feed, Chat list, Tasks),
 * kept on the device so a cold start paints the previous state instantly
 * and refreshes in the background, instead of a skeleton for however long
 * the round trips to the server take.
 *
 * Warmed into memory during the splash (warmScreenCache), so screens read
 * it synchronously in their initial state. Keys are scoped to the signed-in
 * user and everything is wiped on sign-out. Nothing from the vault goes in
 * here — only data the screens already show in plain text.
 */

const PREFIX = 'rootaroo:screen-cache:v1:';

const memory = new Map();
let ownerId = null;

function storageKey(key) {
  return `${PREFIX}${ownerId}:${key}`;
}

export async function warmScreenCache(userId) {
  if (!userId || ownerId === userId) return;
  ownerId = userId;
  memory.clear();
  try {
    const ownPrefix = `${PREFIX}${userId}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(ownPrefix));
    const entries = await AsyncStorage.multiGet(keys);
    if (ownerId !== userId) return; // signed out while reading
    entries.forEach(([k, raw]) => {
      const key = k.slice(ownPrefix.length);
      // A screen may already have written fresher data while this read ran.
      if (!raw || memory.has(key)) return;
      try {
        memory.set(key, JSON.parse(raw));
      } catch {
        /* corrupt entry — the next write replaces it */
      }
    });
  } catch {
    // Storage unavailable: screens just start empty, as they did before.
  }
}

export function readCache(key) {
  return ownerId ? memory.get(key) : undefined;
}

export function writeCache(key, value) {
  if (!ownerId) return;
  memory.set(key, value);
  AsyncStorage.setItem(storageKey(key), JSON.stringify(value)).catch(() => {});
}

export async function clearScreenCache() {
  ownerId = null;
  memory.clear();
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    await AsyncStorage.multiRemove(keys);
  } catch {
    /* best-effort */
  }
}

// ── In-flight request sharing ──
// Several screens ask for the same thing at startup (household, members,
// the dashboard prefetched during the splash). Callers passing the same key
// within maxAgeMs share one request instead of each firing their own.
const inflight = new Map();

export function sharedRequest(key, fn, maxAgeMs = 10000) {
  const hit = inflight.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.promise;
  const promise = fn();
  inflight.set(key, { promise, at: Date.now() });
  // A failed request mustn't be handed to the next caller.
  promise.catch(() => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  });
  return promise;
}

export function clearSharedRequests() {
  inflight.clear();
}
