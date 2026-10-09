const mockRefresh = jest.fn();
jest.mock('../authPersist', () => ({
  saveTokens: jest.fn().mockResolvedValue(), saveHouseholdId: jest.fn(), clearTokens: jest.fn().mockResolvedValue(),
  loadTokens: jest.fn(),
}));
jest.mock('../signupProgress', () => ({ clearSignupProgress: jest.fn().mockResolvedValue(), loadSignupProgress: jest.fn().mockResolvedValue(null) }));
jest.mock('../../api/client', () => ({ __esModule: true, default: { get: jest.fn().mockResolvedValue({ data: { data: [] } }) }, requestTokenRefresh: jest.fn() }));
jest.mock('../../cache/screenCache', () => ({ warmScreenCache: jest.fn().mockResolvedValue(), clearScreenCache: jest.fn(), clearSharedRequests: jest.fn() }));
jest.mock('../../cache/homePrefetch', () => ({ prefetchHome: jest.fn() }));
jest.mock('../feedStore', () => ({ useFeedStore: { getState: () => ({ reset: jest.fn() }) } }));
jest.mock('../../pushNotifications', () => ({ unregisterPushNotificationsAsync: jest.fn() }));
jest.mock('../../device/deviceInfo', () => ({ loadDeviceId: jest.fn().mockResolvedValue() }));
jest.mock('../privateSpaceStore', () => ({
  usePrivateSpaceStore: { getState: () => ({ refresh: mockRefresh, reset: jest.fn() }) },
}));

const { useAuthStore } = require('../authStore');
const { loadTokens } = require('../authPersist');

beforeEach(() => mockRefresh.mockReset().mockResolvedValue());

describe('private space check after sign-in', () => {
  it('signing in asks the server whether this phone still holds the key (a non-holder drops its stale key)', () => {
    useAuthStore.getState().setAuth({ id: 'u1' }, 'access', 'refresh');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('restoring a saved session does the same', async () => {
    loadTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: { id: 'u1' }, householdId: null });
    await useAuthStore.getState().restoreSession();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('a failing check never blocks sign-in', () => {
    mockRefresh.mockImplementation(() => { throw new Error('boom'); });
    expect(() => useAuthStore.getState().setAuth({ id: 'u1' }, 'a', 'r')).not.toThrow();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
