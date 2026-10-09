import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => `id-${Math.random()}`),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  setNotificationHandler: jest.fn(),
}));

const Notifications = require('expo-notifications');
const {
  scheduleSignedOutNudges, cancelSignedOutNudges, suppressSignedOutNudges, NUDGES_KEY, SIGNED_OUT_POOL, NUDGE_DAYS,
} = require('../signedOutNudges');

const DAY = 24 * 60 * 60;
const allowed = (enabled = true) => ({ api: { signedOutAllowed: jest.fn(async () => enabled) } });

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('signed-out nudges', () => {
  it('has a pool of at least eight lines to pick from', () => {
    expect(SIGNED_OUT_POOL.length).toBeGreaterThanOrEqual(8);
    for (const n of SIGNED_OUT_POOL) {
      expect(n.title).toBeTruthy();
      expect(n.body).toBeTruthy();
    }
    expect(new Set(SIGNED_OUT_POOL.map((n) => n.body)).size).toBe(SIGNED_OUT_POOL.length);
  });

  it('schedules nudges on day 2, 7, 21 and 45', async () => {
    expect(NUDGE_DAYS).toEqual([2, 7, 21, 45]);
    await scheduleSignedOutNudges(allowed());
    const seconds = Notifications.scheduleNotificationAsync.mock.calls.map((c) => c[0].trigger.seconds);
    expect(seconds).toEqual([2 * DAY, 7 * DAY, 21 * DAY, 45 * DAY]);
  });

  it('never uses the same line twice in one schedule', async () => {
    await scheduleSignedOutNudges({ ...allowed(), rand: () => 0 });
    const bodies = Notifications.scheduleNotificationAsync.mock.calls.map((c) => c[0].content.body);
    expect(new Set(bodies).size).toBe(bodies.length);
    for (const b of bodies) expect(SIGNED_OUT_POOL.map((n) => n.body)).toContain(b);
  });

  it('nudges carry no personal data and open the app', async () => {
    await scheduleSignedOutNudges(allowed());
    for (const [req] of Notifications.scheduleNotificationAsync.mock.calls) {
      expect(req.content.data).toEqual({ type: 'signed_out_nudge' });
    }
  });

  it('schedules nothing, and clears old ones, when the server has them switched off', async () => {
    await scheduleSignedOutNudges(allowed());
    jest.clearAllMocks();
    await scheduleSignedOutNudges(allowed(false));
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(4);
    expect(await AsyncStorage.getItem(NUDGES_KEY)).toBeNull();
  });

  it('fails closed when the server cannot be asked', async () => {
    await scheduleSignedOutNudges({ api: { signedOutAllowed: jest.fn(async () => { throw new Error('offline'); }) } });
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('replaces an earlier schedule instead of stacking a second one', async () => {
    await scheduleSignedOutNudges(allowed());
    await scheduleSignedOutNudges(allowed());
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await AsyncStorage.getItem(NUDGES_KEY))).toHaveLength(4);
  });

  it('cancels every nudge on sign-in', async () => {
    await scheduleSignedOutNudges(allowed());
    const ids = JSON.parse(await AsyncStorage.getItem(NUDGES_KEY));
    await cancelSignedOutNudges();
    expect(Notifications.cancelScheduledNotificationAsync.mock.calls.map((c) => c[0])).toEqual(ids);
    expect(await AsyncStorage.getItem(NUDGES_KEY)).toBeNull();
  });

  it('does nothing without notification permission', async () => {
    Notifications.getPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await scheduleSignedOutNudges(allowed());
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('after the account is deleted, schedules nothing (also on later launches) until someone signs in', async () => {
    await scheduleSignedOutNudges(allowed());
    jest.clearAllMocks();
    suppressSignedOutNudges();
    await scheduleSignedOutNudges(allowed());
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(4);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    await scheduleSignedOutNudges(allowed());
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    await cancelSignedOutNudges();
    await scheduleSignedOutNudges(allowed());
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(4);
  });
});
