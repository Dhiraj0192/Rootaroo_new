// Journal secrets (account key pair, decrypted photos) must not outlive the session, the lock or the key.
const mockClear = jest.fn();
jest.mock('../../journal/journalRepo', () => ({
  clearJournalSecrets: (...a) => mockClear(...a),
  peekJournalRepo: () => ({ onAppStateChange: jest.fn() }),
}));
const mockClearHeldTap = jest.fn();
jest.mock('../../notificationRouting', () => ({ clearPendingNotification: (...a) => mockClearHeldTap(...a) }));
jest.mock('../authPersist', () => ({
  saveTokens: jest.fn().mockResolvedValue(), saveHouseholdId: jest.fn(), clearTokens: jest.fn().mockResolvedValue(),
  loadTokens: jest.fn(),
}));
jest.mock('../signupProgress', () => ({ clearSignupProgress: jest.fn().mockResolvedValue(), loadSignupProgress: jest.fn().mockResolvedValue(null) }));
jest.mock('../../api/client', () => ({ __esModule: true, default: { get: jest.fn().mockResolvedValue({ data: { data: [] } }) }, requestTokenRefresh: jest.fn() }));
jest.mock('../../cache/screenCache', () => ({ warmScreenCache: jest.fn().mockResolvedValue(), clearScreenCache: jest.fn(), clearSharedRequests: jest.fn() }));
jest.mock('../../cache/homePrefetch', () => ({ prefetchHome: jest.fn() }));
jest.mock('../feedStore', () => ({ useFeedStore: { getState: () => ({ reset: jest.fn() }), setState: jest.fn() } }));
jest.mock('../../pushNotifications', () => ({ unregisterPushNotificationsAsync: jest.fn() }));
jest.mock('../../device/deviceInfo', () => ({ loadDeviceId: jest.fn().mockResolvedValue() }));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

const { useAuthStore } = require('../authStore');
const { useJournalLockStore, JOURNAL_LOCK_GRACE_MS } = require('../journalLockStore');
const { createPrivateSpaceStore } = require('../privateSpaceStore');

beforeEach(() => {
  useJournalLockStore.getState().reset();
  mockClear.mockClear();
});

describe('journal secrets are cleared', () => {
  it('on logout', () => {
    useAuthStore.getState().logout();
    expect(mockClear).toHaveBeenCalled();
  });

  it('logout also drops a held notification tap, so it cannot open for the next account', () => {
    mockClearHeldTap.mockClear();
    useAuthStore.getState().logout();
    expect(mockClearHeldTap).toHaveBeenCalled();
  });

  it('when the private space key is forgotten (also the device-revoked path)', async () => {
    const store = createPrivateSpaceStore({ api: {}, getUserId: () => 'u1' });
    await store.getState().forget();
    expect(mockClear).toHaveBeenCalled();
  });

  it('when the journal lock locks after the grace period', async () => {
    await useJournalLockStore.getState().load();
    await useJournalLockStore.getState().unlock();
    mockClear.mockClear();
    useJournalLockStore.getState().onAppStateChange('background', 1000);
    expect(mockClear).not.toHaveBeenCalled();
    useJournalLockStore.getState().onAppStateChange('active', 1000 + JOURNAL_LOCK_GRACE_MS + 1);
    expect(useJournalLockStore.getState().locked).toBe(true);
    expect(mockClear).toHaveBeenCalled();
  });

  it('not on a short trip to the background', async () => {
    await useJournalLockStore.getState().load();
    await useJournalLockStore.getState().unlock();
    mockClear.mockClear();
    useJournalLockStore.getState().onAppStateChange('background', 1000);
    useJournalLockStore.getState().onAppStateChange('active', 2000);
    expect(mockClear).not.toHaveBeenCalled();
  });
});
