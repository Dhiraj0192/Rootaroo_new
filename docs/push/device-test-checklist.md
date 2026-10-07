# Push notifications: device checklist

Run on one iOS and one Android device, on a build that includes the current native modules. Use two accounts in the same household: A sends, B receives.

| # | Action by A | Expected on B | iOS | Android |
|---|---|---|---|---|
| 1 | Send a chat message while B's app is closed | Push titled with A's name and the message preview; tap opens that chat | | |
| 2 | Send 5 messages within 30 seconds | One push, not five | | |
| 3 | Send a message while B has that chat open | No push; message appears live | | |
| 4 | Send a message while B has a different chat open | Push arrives; the open chat does not show the message | | |
| 5 | Create a feed post | Push; tap opens the post | | |
| 6 | Assign B a task | Push; tap opens the task | | |
| 7 | B completes a task A created | A gets "Task done"; tap opens the task | | |
| 8 | Expense reminder | Push; tap opens the expense | | |
| 9 | Ping B | Push; tap opens Ping | | |
| 10 | Calendar event starting within the hour | One reminder only, even across several 15-minute job runs | | |
| 11 | Reschedule that event to later in the hour | A second reminder arrives | | |
| 12 | A third account joins the household | A and B get "New family member" | | |
| 13 | B turns off a type in Notification preferences, A repeats its action | No push; the item still appears in B's notification list | | |
| 14 | Tap a push while the app is fully closed (cold start) | App opens on the right screen | | |
| 15 | Check the app icon badge, then open Notifications and mark all read | Badge shows the unread count, then clears | | |
| 16 | B uninstalls the app; A sends pushes; wait 30 minutes | Server removes B's dead token (receipts job) | | |
