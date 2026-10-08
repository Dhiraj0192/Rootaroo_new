import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => `id-${Math.random()}`),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  setNotificationHandler: jest.fn(),
}));

const Notifications = require('expo-notifications');
const { scheduleSignedOutNudges, cancelSignedOutNudges, NUDGES_KEY, SIGNED_OUT_NUDGES } = require('../signedOutNudges');

const DAY = 24 * 60 * 60;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('signed-out nudges', () => {
  it('schedules nudges on day 2, 7 and 21', async () => {
    await scheduleSignedOutNudges();
    const seconds = Notifications.scheduleNotificationAsync.mock.calls.map((c) => c[0].trigger.seconds);
    expect(seconds).toEqual([2 * DAY, 7 * DAY, 21 * DAY]);
    expect(SIGNED_OUT_NUDGES).toHaveLength(3);
  });

  it('nudges carry no personal data and open the app', async () => {
    await scheduleSignedOutNudges();
    for (const [req] of Notifications.scheduleNotificationAsync.mock.calls) {
      expect(req.content.title).toBeTruthy();
      expect(req.content.body).toBeTruthy();
      expect(req.content.data).toEqual({ type: 'signed_out_nudge' });
    }
  });

  it('replaces an earlier schedule instead of stacking a second one', async () => {
    await scheduleSignedOutNudges();
    await scheduleSignedOutNudges();
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await AsyncStorage.getItem(NUDGES_KEY))).toHaveLength(3);
  });

  it('cancels every nudge on sign-in', async () => {
    await scheduleSignedOutNudges();
    const ids = JSON.parse(await AsyncStorage.getItem(NUDGES_KEY));
    await cancelSignedOutNudges();
    expect(Notifications.cancelScheduledNotificationAsync.mock.calls.map((c) => c[0])).toEqual(ids);
    expect(await AsyncStorage.getItem(NUDGES_KEY)).toBeNull();
  });

  it('does nothing without notification permission', async () => {
    Notifications.getPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await scheduleSignedOutNudges();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
