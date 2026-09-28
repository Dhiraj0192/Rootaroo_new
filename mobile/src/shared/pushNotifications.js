import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { notificationApi } from './api/notification';
import { ensureNotifications } from './permissions';

// Without a handler, expo-notifications' documented default is to NOT show
// an incoming notification at all while the app is in the foreground —
// pushes only appeared to work when the app was backgrounded/killed
// (where Android's system tray renders the FCM payload natively, no JS
// involved). Registered as an import-time side effect here so it's active
// before any screen mounts, regardless of what imports this module first.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Registers this device for push notifications and hands an Expo push
 * token to the server (`DeviceToken`, sent via Expo's own push relay —
 * `expo-server-sdk` server-side — rather than talking to Firebase/APNs
 * directly). `getExpoPushTokenAsync()` reads the EAS project id from
 * `app.json`'s `extra.eas.projectId` automatically; no explicit `projectId`
 * needed here as long as that's set (via `eas init`).
 *
 * Requires a native rebuild (expo-notifications is declared as a config
 * plugin but not yet compiled into the installed build) for the permission/
 * token APIs to resolve on-device.
 */
export async function registerForPushNotificationsAsync() {
  try {
    // Silent on purpose: this runs opportunistically at launch, so a refusal
    // must not throw the permission sheet in front of someone who never asked
    // for it. An explicit, user-initiated ask belongs on a screen (e.g.
    // NotificationPreferences), where the sheet is the right response.
    if (!(await ensureNotifications({ silent: true }))) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    if (!token) return;

    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    await notificationApi.registerToken(token, platform);
  } catch {
    // Best-effort — push is a delivery enhancement, never block the app on it.
  }
}

/**
 * Unregisters this device's push token on logout, so the server stops
 * targeting a device that's no longer signed in. Re-derives the token via
 * `getExpoPushTokenAsync()` rather than persisting it separately — cheap
 * (native-cached, no new permission prompt) once permission was already
 * granted, matching how registration itself re-derives on every launch.
 */
export async function unregisterPushNotificationsAsync(accessToken) {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    if (!token) return;

    await notificationApi.unregisterToken(token, accessToken);
  } catch {
    // Best-effort, same as registration.
  }
}
