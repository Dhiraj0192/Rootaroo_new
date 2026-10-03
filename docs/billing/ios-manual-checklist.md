# iOS manual checklist (real device, dev client) - Rootaroo billing Phase 1

Run on a physical iPhone with an EAS development build that includes the `rootaroo` scheme (the scheme was renamed in Wave 1, so an older dev client will not open `rootaroo://` links).

| # | Step | Expected | Pass |
|---|---|---|---|
| 1 | Open `rootaroo://billing/cancel` from Notes | App opens | |
| 2 | Onboarding pricing shows prices from the server and the auto-renewal disclosure | Matches `/billing/plans` | |
| 3 | Subscribe (4242...) in the auth session sheet | Sheet closes on success; MainTabs within 10 s | |
| 4 | Swipe the sheet away before paying | "Checkout was not completed."; paywall stays | |
| 5 | 3-D Secure card 4000 0025 0000 3155 | Challenge completes; app shows "Confirming..." then unlocks | |
| 6 | More, Subscription, Manage subscription | Stripe portal opens; return lands back in the app | |
| 7 | Background the app, cancel in portal on desktop, foreground the app | Subscription shows "Ends on <date>" | |
| 8 | Member account on a second device while the household is blocked | "Ask <admin> to renew Rootaroo" | |
| 9 | Grace period (staff planted via test clock) | Red banner with Fix payment for the admin | |
| 10 | Terms and Privacy links on the paywall and onboarding pricing screen | Open the owner-confirmed URLs | |
