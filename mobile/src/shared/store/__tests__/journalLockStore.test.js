import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

const LocalAuthentication = require('expo-local-authentication');
const { useJournalLockStore, JOURNAL_LOCK_KEY, JOURNAL_LOCK_GRACE_MS } = require('../journalLockStore');

const store = () => useJournalLockStore.getState();

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  store().reset();
});

describe('journalLockStore', () => {
  it('re-locks only after a 1 minute grace', () => {
    expect(JOURNAL_LOCK_GRACE_MS).toBe(60000);
  });

  it('starts unloaded', () => {
    expect(store().enabled).toBeNull();
  });

  it('defaults to on and locked when the device has biometrics or a passcode', async () => {
    await store().load();
    expect(store().available).toBe(true);
    expect(store().enabled).toBe(true);
    expect(store().locked).toBe(true);
  });

  it('defaults to off when the device has no screen lock', async () => {
    LocalAuthentication.isEnrolledAsync.mockResolvedValueOnce(false);
    await store().load();
    expect(store().available).toBe(false);
    expect(store().enabled).toBe(false);
    expect(store().locked).toBe(false);
  });

  it('a saved choice wins over the default', async () => {
    await AsyncStorage.setItem(JOURNAL_LOCK_KEY, 'off');
    await store().load();
    expect(store().enabled).toBe(false);
    expect(store().locked).toBe(false);
  });

  it('setEnabled persists the choice and never locks the user out of the screen they are on', async () => {
    await store().load();
    await store().unlock();
    await store().setEnabled(false);
    expect(await AsyncStorage.getItem(JOURNAL_LOCK_KEY)).toBe('off');
    expect(store().locked).toBe(false);
    await store().setEnabled(true);
    expect(await AsyncStorage.getItem(JOURNAL_LOCK_KEY)).toBe('on');
    expect(store().enabled).toBe(true);
    expect(store().locked).toBe(false);
  });

  it('unlock asks the OS and clears the lock on success', async () => {
    await store().load();
    const ok = await store().unlock();
    expect(ok).toBe(true);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: 'Unlock your journal' }),
    );
    expect(store().locked).toBe(false);
  });

  it('a failed or cancelled unlock keeps the journal locked', async () => {
    await store().load();
    LocalAuthentication.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' });
    expect(await store().unlock()).toBe(false);
    expect(store().locked).toBe(true);
  });

  it('lets the user in without a prompt when the screen lock was removed after enabling', async () => {
    await AsyncStorage.setItem(JOURNAL_LOCK_KEY, 'on');
    LocalAuthentication.isEnrolledAsync.mockResolvedValueOnce(false);
    await store().load();
    expect(await store().unlock()).toBe(true);
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    expect(store().locked).toBe(false);
  });

  it('stays unlocked after a quick app switch', async () => {
    await store().load();
    await store().unlock();
    store().onAppStateChange('background', 1000);
    store().onAppStateChange('active', 1000 + 59000);
    expect(store().locked).toBe(false);
  });

  it('locks again after a minute in the background', async () => {
    await store().load();
    await store().unlock();
    store().onAppStateChange('background', 1000);
    store().onAppStateChange('active', 1000 + 60000);
    expect(store().locked).toBe(true);
  });

  it('measures from the first background event, not repeated ones', async () => {
    await store().load();
    await store().unlock();
    store().onAppStateChange('background', 0);
    store().onAppStateChange('background', 50000);
    store().onAppStateChange('active', 61000);
    expect(store().locked).toBe(true);
  });

  it('never locks when the lock is off', async () => {
    await store().load();
    await store().setEnabled(false);
    store().onAppStateChange('background', 0);
    store().onAppStateChange('active', 10 * 60000);
    expect(store().locked).toBe(false);
  });

  it('reset returns to the unloaded state (used on logout)', async () => {
    await store().load();
    store().reset();
    expect(store().enabled).toBeNull();
    expect(store().locked).toBe(false);
  });
});
