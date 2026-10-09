import AsyncStorage from '@react-native-async-storage/async-storage';

const {
  LOCATION_SHARE_TASK,
  ACTIVE_SHARE_KEY,
  handleLocationTask,
  startSharing,
  stopSharing,
} = require('../backgroundShare');

const NOW = new Date('2026-10-08T10:00:00Z').getTime();

function fakeLocation(overrides = {}) {
  return {
    requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    getCurrentPositionAsync: jest.fn(async () => ({ coords: { latitude: 27.7, longitude: 85.3, accuracy: 12 } })),
    startLocationUpdatesAsync: jest.fn(async () => {}),
    stopLocationUpdatesAsync: jest.fn(async () => {}),
    hasStartedLocationUpdatesAsync: jest.fn(async () => true),
    Accuracy: { Balanced: 3 },
    ...overrides,
  };
}
function fakeApi(overrides = {}) {
  return {
    create: jest.fn(async (body) => ({ id: 's1', expiresAt: new Date(NOW + body.durationMinutes * 60_000).toISOString() })),
    updateLocation: jest.fn(async () => ({})),
    stop: jest.fn(async () => ({})),
    ...overrides,
  };
}
const deps = (o = {}) => ({ Location: fakeLocation(o.Location), api: fakeApi(o.api), now: () => NOW });

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('startSharing', () => {
  it('creates the share at the current position and starts background updates', async () => {
    const d = deps();
    const result = await startSharing({ durationMinutes: 60, viewerIds: null }, d);
    expect(d.api.create).toHaveBeenCalledWith({ durationMinutes: 60, viewerIds: null, latitude: 27.7, longitude: 85.3, accuracy: 12 });
    expect(d.Location.startLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_SHARE_TASK, expect.objectContaining({
      accuracy: 3,
      distanceInterval: 50,
      showsBackgroundLocationIndicator: true,
      foregroundService: expect.objectContaining({ notificationTitle: 'Sharing location with family' }),
    }));
    expect(result.mode).toBe('background');
    expect(JSON.parse(await AsyncStorage.getItem(ACTIVE_SHARE_KEY))).toEqual({ id: 's1', expiresAt: new Date(NOW + 3600_000).toISOString() });
  });

  it('falls back to foreground sharing when "Always" is refused', async () => {
    const d = deps({ Location: { requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })) } });
    const result = await startSharing({ durationMinutes: 15, viewerIds: ['u2'] }, d);
    expect(result.mode).toBe('foreground');
    expect(d.Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(d.api.create).toHaveBeenCalled();
  });

  it('refuses to start without location permission and creates nothing', async () => {
    const d = deps({ Location: { requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })) } });
    await expect(startSharing({ durationMinutes: 15, viewerIds: null }, d)).rejects.toThrow('Location permission is needed to share');
    expect(d.api.create).not.toHaveBeenCalled();
  });

  it('never asks for more than 8 hours', async () => {
    const d = deps();
    await startSharing({ durationMinutes: 24 * 60, viewerIds: null }, d);
    expect(d.api.create).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 480 }));
  });
});

describe('handleLocationTask', () => {
  const locations = [
    { coords: { latitude: 1, longitude: 2, accuracy: 30 } },
    { coords: { latitude: 3, longitude: 4, accuracy: 10 } },
  ];

  it('sends only the newest position for the active share', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW + 60_000).toISOString() }));
    const d = deps();
    await handleLocationTask({ data: { locations }, error: null }, d);
    expect(d.api.updateLocation).toHaveBeenCalledWith('s1', { latitude: 3, longitude: 4, accuracy: 10 });
  });

  it('stops itself once the share has expired', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW - 1).toISOString() }));
    const d = deps();
    await handleLocationTask({ data: { locations }, error: null }, d);
    expect(d.api.updateLocation).not.toHaveBeenCalled();
    expect(d.Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_SHARE_TASK);
    expect(await AsyncStorage.getItem(ACTIVE_SHARE_KEY)).toBeNull();
  });

  it('stops itself when there is no active share', async () => {
    const d = deps();
    await handleLocationTask({ data: { locations }, error: null }, d);
    expect(d.Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_SHARE_TASK);
  });

  it('stops when the server says the share ended (stopped elsewhere or expired)', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW + 60_000).toISOString() }));
    const d = deps({ api: { updateLocation: jest.fn(async () => { const e = new Error('gone'); e.response = { status: 410 }; throw e; }) } });
    await handleLocationTask({ data: { locations }, error: null }, d);
    expect(d.Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_SHARE_TASK);
    expect(await AsyncStorage.getItem(ACTIVE_SHARE_KEY)).toBeNull();
  });

  it('keeps sharing through a temporary network error', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW + 60_000).toISOString() }));
    const d = deps({ api: { updateLocation: jest.fn(async () => { throw new Error('Network Error'); }) } });
    await expect(handleLocationTask({ data: { locations }, error: null }, d)).resolves.toBeUndefined();
    expect(d.Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('ignores task errors without crashing', async () => {
    const d = deps();
    await expect(handleLocationTask({ data: null, error: new Error('boom') }, d)).resolves.toBeUndefined();
    expect(d.api.updateLocation).not.toHaveBeenCalled();
  });
});

describe('stopSharing', () => {
  it('ends the share on the server, clears it and stops background updates', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW + 60_000).toISOString() }));
    const d = deps();
    await stopSharing(d);
    expect(d.api.stop).toHaveBeenCalledWith('s1');
    expect(d.Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(LOCATION_SHARE_TASK);
    expect(await AsyncStorage.getItem(ACTIVE_SHARE_KEY)).toBeNull();
  });

  it('still stops locally when the server call fails', async () => {
    await AsyncStorage.setItem(ACTIVE_SHARE_KEY, JSON.stringify({ id: 's1', expiresAt: new Date(NOW + 60_000).toISOString() }));
    const d = deps({ api: { stop: jest.fn(async () => { throw new Error('offline'); }) } });
    await stopSharing(d);
    expect(d.Location.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_SHARE_KEY)).toBeNull();
  });
});
