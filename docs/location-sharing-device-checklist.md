# Location sharing: device test checklist

Background location needs a development or release build on a physical device (not Expo Go, not a simulator for background behaviour). Test on at least one iOS and one Android device, with two household accounts (sharer and viewer) signed in on separate devices.

Mark each row Pass / Fail with the build number and OS version.

## Starting a share

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Start a 15 min share with "Everyone" | Banner shows "Sharing your location" with time left; viewer gets a push and sees a pin with name and "Updated ... ago" |
| 2 | Start a 1 hour share | Banner counts down from about 1 h; viewer pin appears |
| 3 | Start an 8 hours share | Banner counts down from about 8 h; no longer duration is selectable |
| 4 | Start a share with "Choose people" and one member selected | Only that member sees the pin; other members do not |
| 5 | Start button with "Choose people" and nobody selected | Start is disabled |
| 6 | Allow "Always" (when asked) | Banner shows no warning; background mode is used |
| 7 | Deny "Always", allow while using | Banner shows the "Keep Rootaroo open" warning; sharing continues only while the app is open |
| 8 | Deny location entirely | Sharing does not start; a clear message is shown and no share exists on the server |

## Background behaviour

| # | Scenario | Expected |
|---|----------|----------|
| 9 | iOS: start a share, send the app to the background, move around | Blue status bar indicator shows; viewer pin keeps moving |
| 10 | Android: start a share, send the app to the background, move around | Persistent notification "Sharing location with family" shows; viewer pin keeps moving |
| 11 | iOS: swipe the app away (killed) mid-share | Updates continue (or resume) and the viewer pin keeps moving until expiry |
| 12 | Android: swipe the app away mid-share | Foreground service keeps running; viewer pin keeps moving until expiry |
| 13 | Reopen the app mid-share | Banner and remaining time are restored; no duplicate share is created |
| 14 | Airplane mode for a minute, then back online | Sharing resumes without restarting; pin catches up |

## Stopping

| # | Scenario | Expected |
|---|----------|----------|
| 15 | Tap Stop on the banner | Banner disappears; viewer pin disappears; iOS indicator and Android notification go away |
| 16 | Let a 15 min share expire with the app backgrounded | Updates stop, the Android notification and iOS indicator go away, viewer pin is removed |
| 17 | Stop the share from a second device signed in as the same user | The first device stops background updates |

## Pings

| # | Scenario | Expected |
|---|----------|----------|
| 18 | Request a member's location, they accept and choose a duration (including 8 hours) | Requester sees a live pin that moves; nobody else in the household sees it |
| 19 | The member accepts, then stops from the banner | Requester pin disappears |
| 20 | The member declines the ping | No share is created; no location is shared |
| 21 | Tap the "location share started" push | App opens on the Ping screen with the pin visible |

## Roles and access

| # | Scenario | Expected |
|---|----------|----------|
| 22 | Viewer sees a moving pin with the sharer's name and "Updated ... ago" | Label refreshes as updates arrive |
| 23 | A child account can start, stop and decline | All three work |
| 24 | Remove a member from the household while they are viewing | Their app no longer shows the pin and the server refuses their share requests |
| 25 | Removed sharer's active share | Share ends; no further updates reach the household |
