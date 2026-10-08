import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { campaignsApi } from './api/campaigns';

export const NUDGES_KEY = 'rootaroo_signed_out_nudges';

const DAY_SECONDS = 24 * 60 * 60;

// One nudge is scheduled per day in NUDGE_DAYS, each with a different line from the pool.
export const NUDGE_DAYS = [2, 7, 21, 45];

export const SIGNED_OUT_POOL = [
  { title: 'Rootaroo', body: "Your family's updates are piling up. Sign back in? 🦘" },
  { title: 'Rootaroo', body: 'Rootaroo keeps the family in sync. Your seat is still warm.' },
  { title: 'Rootaroo', body: 'Chores, plans, check-ins. Your household lives here. Come back anytime 🏡' },
  { title: 'Rootaroo', body: 'The grocery list called. It wants its favourite shopper back 🛒' },
  { title: 'Rootaroo', body: 'Somewhere, a chore is going undone. Just saying. 🧹' },
  { title: 'Rootaroo', body: 'Your roo is doing laps waiting for you. Hop back in? 🦘' },
  { title: 'Rootaroo', body: 'Family plans are better with you in them. Sign in to catch up 📅' },
  { title: 'Rootaroo', body: 'New photos, check-ins, maybe a dinner plan. Come take a look 👀' },
  { title: 'Rootaroo', body: "One tap and you're back with the family 💛" },
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

// Fisher–Yates over a copy, so the pool itself is never reordered.
function pickDistinct(pool, count, rand) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

async function scheduleNow({ api, rand }) {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    // Fail closed: if the server cannot confirm nudges are on, send none.
    let allowed = false;
    try {
      allowed = (await api.signedOutAllowed()) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      await cancelStoredIds();
      return;
    }

    await cancelStoredIds();

    const lines = pickDistinct(SIGNED_OUT_POOL, NUDGE_DAYS.length, rand);
    const ids = [];
    for (let i = 0; i < NUDGE_DAYS.length; i += 1) {
      const nudge = lines[i];
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: nudge.title,
          body: nudge.body,
          data: { type: 'signed_out_nudge' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: NUDGE_DAYS[i] * DAY_SECONDS,
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

export function scheduleSignedOutNudges(deps = {}) {
  const { api = campaignsApi, rand = Math.random } = deps;
  return enqueue(() => scheduleNow({ api, rand }));
}

export function cancelSignedOutNudges() {
  return enqueue(cancelNow);
}
