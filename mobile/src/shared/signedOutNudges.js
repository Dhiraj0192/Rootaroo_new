import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

export const NUDGES_KEY = 'rootaroo_signed_out_nudges';

const DAY_SECONDS = 24 * 60 * 60;

export const SIGNED_OUT_NUDGES = [
  {
    days: 2,
    title: 'Rootaroo',
    body: "Your family's updates are piling up. Sign back in? 🦘",
  },
  {
    days: 7,
    title: 'Rootaroo',
    body: 'Rootaroo keeps the family in sync. Your seat is still warm.',
  },
  {
    days: 21,
    title: 'Rootaroo',
    body: 'Chores, plans, check-ins. Your household lives here. Come back anytime 🏡',
  },
];

async function readStoredIds() {
  try {
    const raw = await AsyncStorage.getItem(NUDGES_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

async function cancelStoredIds() {
  const ids = await readStoredIds();
  await Promise.all(
    ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})),
  );
  await AsyncStorage.removeItem(NUDGES_KEY).catch(() => {});
}

// Schedule and cancel both rewrite the stored id list, so they run one at a time.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function scheduleNow() {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    await cancelStoredIds();

    const ids = [];
    for (const nudge of SIGNED_OUT_NUDGES) {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: nudge.title,
          body: nudge.body,
          data: { type: 'signed_out_nudge' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: nudge.days * DAY_SECONDS,
          repeats: false,
        },
      });
      ids.push(id);
    }
    await AsyncStorage.setItem(NUDGES_KEY, JSON.stringify(ids));
  } catch {
    // Nudges are optional. A failure here must never block sign-out or launch.
  }
}

async function cancelNow() {
  try {
    await cancelStoredIds();
  } catch {
    // Nothing to cancel is not an error.
  }
}

export function scheduleSignedOutNudges() {
  return enqueue(scheduleNow);
}

export function cancelSignedOutNudges() {
  return enqueue(cancelNow);
}
