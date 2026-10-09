import { create } from 'zustand';
import { AppState } from 'react-native';
import { locationSharesApi } from '../api/locationShares';
import * as background from '../location/backgroundShare';
import { useAuthStore } from './authStore';

const FOREGROUND_TICK_MS = 45_000;

let tickTimer = null;

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

// Foreground fallback: without "Always" permission, send a position while the app is open.
function syncTick(get) {
  const { mine, mode } = get();
  if (!mine || mode !== 'foreground') {
    stopTick();
    return;
  }
  if (tickTimer) return;
  tickTimer = setInterval(async () => {
    const { mine: current, mode: currentMode } = get();
    if (!current || currentMode !== 'foreground') return stopTick();
    if (Date.now() >= new Date(current.expiresAt).getTime()) {
      await get().clearMine();
      return;
    }
    if (AppState.currentState !== 'active') return;
    try {
      const Location = require('expo-location');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await locationSharesApi.updateLocation(current.id, {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
    } catch (e) {
      if (e?.response?.status === 410) await get().clearMine();
    }
  }, FOREGROUND_TICK_MS);
}

// A position update can arrive after the end event (or from a slow request); don't revive the share.
const RECENTLY_ENDED_MS = 5 * 60_000;
const recentlyEnded = new Map();

function wasRecentlyEnded(id) {
  const at = recentlyEnded.get(id);
  if (at == null) return false;
  if (Date.now() - at > RECENTLY_ENDED_MS) {
    recentlyEnded.delete(id);
    return false;
  }
  return true;
}

const myId = () => useAuthStore.getState().user?.id;

export const useLocationShareStore = create((set, get) => ({
  mine: null,
  visible: [],
  mode: null,

  refresh: async () => {
    try {
      const { mine, visible } = await locationSharesApi.list();
      const active = mine ? await background.getActiveShare() : null;
      let mode = get().mode;
      if (!mine) mode = null;
      else if (active?.id === mine.id && !mode) {
        let started = false;
        try {
          started = await require('expo-location').hasStartedLocationUpdatesAsync(background.LOCATION_SHARE_TASK);
        } catch {
          // treat as not started
        }
        mode = started ? 'background' : 'foreground';
      }
      set({ mine: mine || null, visible: visible || [], mode: mine ? mode || 'background' : null });
      syncTick(get);
    } catch {
      // keep what we have; the next refresh or socket event corrects it
    }
  },

  start: async (opts) => {
    const { share, mode } = await background.startSharing(opts);
    set({ mine: share, mode });
    syncTick(get);
    return share;
  },

  // Tracks a share the server created for us (accepting a ping).
  attach: async (share) => {
    const { mode } = await background.attachSharing(share);
    set({ mode });
    await get().refresh();
    syncTick(get);
  },

  stop: async () => {
    stopTick();
    await background.stopSharing();
    set({ mine: null, mode: null });
  },

  // Ended elsewhere (expiry, other device): tear down local tracking only.
  clearMine: async () => {
    stopTick();
    await background.stopTracking(undefined);
    set({ mine: null, mode: null });
  },

  onStarted: (share) => {
    if (share.sharer?.id === myId()) {
      set({ mine: share });
      return;
    }
    set((s) => ({ visible: [share, ...s.visible.filter((x) => x.id !== share.id)] }));
  },

  onUpdate: (share) => {
    if (share.endedAt || new Date(share.expiresAt).getTime() <= Date.now() || wasRecentlyEnded(share.id)) return;
    if (share.sharer?.id === myId()) {
      set((s) => (s.mine?.id === share.id ? { mine: share } : s));
      return;
    }
    set((s) => ({
      visible: s.visible.some((x) => x.id === share.id)
        ? s.visible.map((x) => (x.id === share.id ? share : x))
        : [share, ...s.visible],
    }));
  },

  onEnded: (share) => {
    recentlyEnded.set(share.id, Date.now());
    set((s) => ({ visible: s.visible.filter((x) => x.id !== share.id) }));
    if (get().mine?.id === share.id) get().clearMine();
  },
}));
