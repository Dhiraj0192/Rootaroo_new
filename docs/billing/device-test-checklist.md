# Store billing device checklist (Apple IAP and Google Play) - OWNER-RUN

Nothing in this file has been run. The server side (receivers, verification, reconciliation) is covered by fixture tests; every row below needs a real device, a real store account and the store consoles. Run it before the release gate. Tick the Pass column and note anything unexpected.

Needs a new EAS development build: `expo-iap` (config plugin `expo-iap` in `mobile/app.json`) is a native module, so Expo Go and every older dev client lack it. Without it the paywall falls back to "Purchasing isn't available here yet" for `apple_iap` and `google_play` routes.

## 0. One-time setup

| # | Step | Expected | Pass |
|---|---|---|---|
| 0.1 | App Store Connect: one subscription group, 12 auto-renewable subscriptions `rootaroo.hh{5..10}.month` and `rootaroo.hh{5..10}.year`, ranked by size so a larger size is an upgrade | All 12 "Ready to Submit" with prices as close to the spec price table as Apple's tiers allow | |
| 0.2 | App Store Connect: In-App Purchase API key (Users and Access, Integrations). Put `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`, `APPLE_APP_APPLE_ID` (and `APPLE_BUNDLE_ID` if not `com.rootaroo.app`) in the server env | Server logs `[Billing] iap apple=on` on boot | |
| 0.3 | App Store Connect: App Store Server Notifications URL for Sandbox and Production set to `https://<api>/api/v1/billing/webhooks/apple`, version 2. Use "Request a Test Notification" | Server stores a `TEST` event as `ignored` (row in `billing_events`, provider `apple`) | |
| 0.4 | Play Console: 6 subscriptions `rootaroo.hh5` ... `rootaroo.hh10`, each with base plans `month` and `year` (plan IDs exactly `month` and `year`), all active | Products visible to the internal testing track | |
| 0.5 | Play Console: API access linked to a Google Cloud project; service account with "View financial data" and "Manage orders and subscriptions". Put its key JSON in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` and set `GOOGLE_PLAY_PACKAGE_NAME` | Server logs `[Billing] iap google=on` | |
| 0.6 | Cloud Pub/Sub: topic for Play RTDN, push subscription to `https://<api>/api/v1/billing/webhooks/google` with OIDC authentication as a service account. Set `GOOGLE_PLAY_RTDN_AUDIENCE` to that exact URL and `GOOGLE_PLAY_RTDN_SA_EMAIL` to the service account. Play Console, Monetization setup: set the topic and send a test notification | A `TEST` event arrives as `ignored`; a push with a wrong token is 401 | |
| 0.7 | Staff: routing rules send the test device to the store (for example `(ios,*) -> apple_iap`, `(android,*) -> google_play`) and the test household is NOT in the `test` cohort (the cohort always routes to Stripe) | `GET /billing/status` returns `purchaseMethod: apple_iap` or `google_play` for the device | |
| 0.8 | Tunnel the server for sandbox delivery (for example ngrok or cloudflared) and use the tunnel URL in the consoles above | Notifications reach the local server | |

## 1. Apple (iPhone, EAS dev build)

Use a Sandbox Apple Account (App Store Connect, Users and Access, Sandbox) signed in under Settings, Developer, Sandbox Apple Account. Sandbox renewals are fast (monthly renews every 5 minutes, up to 6 times). A StoreKit configuration file (Xcode) works for UI-only checks of the sheet but sends no notifications to the server; use the real sandbox for everything below.

| # | Step | Expected | Pass |
|---|---|---|---|
| 1.1 | Onboarding pricing or Paywall on the Apple route | Shows the App Store's own localized prices and the auto-renewal text with that price | |
| 1.2 | Subscribe to a size (for example 7 members, yearly) | Apple sheet appears; after confirming, the app unlocks within a few seconds; `billing_subscriptions` has provider `apple`, `livemode=0`, seats 7, `purchased_by_user_id` set | |
| 1.3 | Check `billing_events` and `billing_transactions` | `SUBSCRIBED.INITIAL_BUY` event `processed`; one `payment` ledger row (provider `apple`) | |
| 1.4 | Dismiss the Apple sheet without buying | "The purchase was not completed."; paywall stays | |
| 1.5 | Wait for a sandbox renewal | `DID_RENEW` processed; `current_period_end` moves; a second payment row appears | |
| 1.6 | Turn off auto-renew in Settings, Subscriptions (sandbox) | `DID_CHANGE_RENEWAL_STATUS`; Subscription screen shows "Ends on <date>" and access continues | |
| 1.7 | Let it expire | `EXPIRED`; the household sees the paywall; members see "Ask <admin> to renew" | |
| 1.8 | Refund: in the sandbox, Apple support tool or the Request Refund sheet (iOS) | `REFUND` event; access revoked immediately; a `refund` ledger row | |
| 1.9 | Billing retry: sandbox payment failure (Sandbox account, "Interrupt purchases" setting off and a failing payment) | `DID_FAIL_TO_RENEW` with grace; grace banner for the admin; notification "Your Rootaroo payment failed" | |
| 1.10 | Upgrade 5 to 8 in the same group (Subscription screen, Manage subscription) | Upgrade applies at once; seats become 8; `DID_CHANGE_RENEWAL_PREF` (UPGRADE) processed | |
| 1.11 | Downgrade 8 to 6 | Seats stay 8 until renewal; `pending_update` set; after renewal seats become 6 | |
| 1.12 | Delete the app, reinstall, sign in, Restore purchases | The household unlocks again without a second charge | |
| 1.13 | Sign in as a user of a DIFFERENT household on the same Apple ID, Restore purchases | "This purchase belongs to a different household." and no entitlement | |
| 1.14 | Manage subscription | Opens the Apple subscriptions page | |
| 1.15 | Storefront: set the sandbox storefront to a non-US country, relaunch | `X-Store-Country` is that country's alpha-2 code (check server logs or `GET /billing/status` routing) | |
| 1.16 | Notification delivery through the tunnel: kill the tunnel, trigger a renewal, bring it back | Apple retries; the event arrives once and is processed once | |

## 2. Google Play (Android phone, EAS dev build)

Add the tester Gmail under Play Console, Settings, License testing, and install through the internal testing track. License-test purchases map to `livemode=0`. Test subscriptions renew every few minutes.

| # | Step | Expected | Pass |
|---|---|---|---|
| 2.1 | Paywall on the Google route | Shows Google Play's localized base-plan prices and the auto-renewal text | |
| 2.2 | Subscribe to a size | Play sheet appears; after confirming the app unlocks; `billing_subscriptions` has provider `google`, `livemode=0`, the right seats and interval; the purchase is acknowledged (Play Console, Order management shows no pending acknowledgement) | |
| 2.3 | RTDN `SUBSCRIPTION_PURCHASED` | Event `processed`; its `livemode` is corrected to 0 because the Play API reports a test purchase | |
| 2.4 | Dismiss the Play sheet | "The purchase was not completed." | |
| 2.5 | Wait for a renewal | `SUBSCRIPTION_RENEWED`; period moves; a new `payment` row keyed by the order ID (`GPA...`) | |
| 2.6 | Cancel in Play, Subscriptions | `SUBSCRIPTION_CANCELED`; access continues; Subscription screen shows "Ends on <date>" | |
| 2.7 | Resubscribe from Play before expiry | `SUBSCRIPTION_RESTARTED`; "Ends on" disappears | |
| 2.8 | Let it expire | `SUBSCRIPTION_EXPIRED`; paywall | |
| 2.9 | Payment failure (test card "slow decline" or "always decline") | `SUBSCRIPTION_IN_GRACE_PERIOD` keeps access and shows the grace banner; later `SUBSCRIPTION_ON_HOLD` removes access; fixing the payment gives `SUBSCRIPTION_RECOVERED` | |
| 2.10 | Refund or revoke the order in Play Console | Voided purchase notification; access revoked; a `refund` ledger row | |
| 2.11 | Slow test card ("pending") | Purchase shows as pending; no access and no acknowledgement until it completes | |
| 2.12 | Change size in Play (upgrade or downgrade) | The new token replaces the old one: one active row, no "two subscriptions" review item | |
| 2.13 | Reinstall and Restore purchases | Unlocks without a second charge | |
| 2.14 | Restore purchases with another household signed in | "This purchase belongs to a different household." | |
| 2.15 | Manage subscription | Opens the Play subscription page for that subscription | |
| 2.16 | Pub/Sub delivery: stop the tunnel, trigger a renewal, restart | Pub/Sub retries; one event row, processed once | |
| 2.17 | Break the acknowledge (revoke the service account's order permission), buy | Access is granted; a `google_ack_failed` review item appears; restoring the permission and running reconciliation acknowledges it | |

## 3. Cross-provider

| # | Step | Expected | Pass |
|---|---|---|---|
| 3.1 | Household with an active Stripe subscription buys on Apple (use a household in the test cohort for Stripe, then switch the device route) | `cross_provider_duplicate` review item; the admin gets "Your household has two Rootaroo subscriptions"; neither subscription is cancelled automatically | |
| 3.2 | Same with Google | Same result | |
| 3.3 | Staff cohort change with `force` while the household has a store subscription | The store subscription is NOT cancelled; a `store_subscription_cohort_change` review item appears; the cohort changes | |
| 3.4 | Admin who bought through a store deletes their account (30 day window elapsed or forced in a dev DB) | Admins are told to resubscribe before the period ends; `store_purchaser_deleted` review item | |
| 3.5 | Household deletion while a store subscription is active | Staff get a review item; the leave/delete flow warns that the store subscription must be cancelled in the store | |
| 3.6 | Run staff reconciliation (`POST /billing-admin/reconcile`) with a store subscription whose last notification was missed | The row is refetched from the store API and a `subscription_drift` auto-fix is recorded | |

## 4. Known limits to confirm before launch

- Apple reviewers purchase in the Sandbox environment against whichever server the build points at. A Sandbox purchase is stored with `livemode=0`; in production a `live`-cohort household only counts `livemode=1` subscriptions, so a reviewer purchase would not unlock. Decide before submission: put the review account's household in the `test` cohort, or accept Sandbox purchases for it.
- Non-USD store prices are stored in the store's currency (the `currency` column). The staff summary (`/billing-admin/summary`) counts USD rows only, so non-USD store revenue is visible in `/transactions` but not in the summary totals or MRR until a currency policy is decided.
- The Apple chain check uses OCSP revocation (production only) and needs outbound access to Apple's OCSP responders.
