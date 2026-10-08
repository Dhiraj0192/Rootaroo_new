import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

export const JOURNAL_LOCK_KEY = 'rootaroo_journal_lock';
export const JOURNAL_LOCK_GRACE_MS = 60000;

const initial = {
  enabled: null,
  available: false,
  locked: false,
  backgroundedAt: null,
};

export const useJournalLockStore = create((set, get) => ({
  ...initial,

  load: async () => {
    const available = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    let saved = null;
    try {
      saved = await AsyncStorage.getItem(JOURNAL_LOCK_KEY);
    } catch {
      /* unreadable: fall back to the default */
    }
    const enabled = saved === 'on' ? true : saved === 'off' ? false : available;
    set({ available, enabled, locked: enabled });
  },

  setEnabled: async (value) => {
    try {
      await AsyncStorage.setItem(JOURNAL_LOCK_KEY, value ? 'on' : 'off');
    } catch {
      /* not persisted: applies for this session only */
    }
    set({ enabled: value, locked: false });
  },

  unlock: async () => {
    const { enabled, available } = get();
    if (!enabled || !available) {
      set({ locked: false });
      return true;
    }
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock your journal' });
    if (result?.success) {
      set({ locked: false });
      return true;
    }
    return false;
  },

  onAppStateChange: (nextState, now = Date.now()) => {
    // Decrypted journal keys are dropped on the same schedule as the lock.
    require('../journal/journalRepo').peekJournalRepo()?.onAppStateChange(nextState, now);
    const { enabled, backgroundedAt } = get();
    if (nextState === 'background') {
      if (backgroundedAt === null) set({ backgroundedAt: now });
    } else if (nextState === 'active') {
      if (enabled && backgroundedAt !== null && now - backgroundedAt >= JOURNAL_LOCK_GRACE_MS) {
        set({ locked: true });
      }
      set({ backgroundedAt: null });
    }
  },

  reset: () => set({ ...initial }),
}));
