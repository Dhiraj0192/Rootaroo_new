# Wave 9 gate evidence: mobile billing

Date: 2026-10-03. Branch feat/billing. No secrets in this file.

## Commits

- 68bf5f01 Task 9.0 (server): the billing-admin audit log no longer stores the `email` query filter verbatim; it stores `sha256:<first 16 hex of the lowercased, trimmed address>`. Test: `adminAuth.test.ts` "redacts the email filter (PII) before storing the query".
- 9.1 billing API, single-flight 402 refresh, persisted billing store, jest-expo test toolchain
- 9.2 prices from `/billing/plans`; `PRICE` constant removed
- 9.3 checkout flow helper (always syncs, polls while processing); `legalLinks.js`
- 9.4 paywall screens, grace banner, `RootNavigator` gating
- 9.5 subscription screen (More, Subscription)
- 9.6 onboarding purchase on `FeaturePricingScreen`
- 9.7 this file and `docs/billing/ios-manual-checklist.md`

(Hashes for 9.1-9.7 are in `git log --oneline`; every message carries the single Claude Opus 5.5 trailer.)

## Gate results

| Check | Result |
|---|---|
| `cd mobile && npx jest` | 10 suites, 75 passed, 6 skipped (the skipped ones are the fixtures placeholder and pre-existing skips), 0 failed. Includes the pre-existing `vaultCrypto.test.js`, which now runs under jest-expo |
| `npx expo export --platform android` | Succeeded: one Android Hermes bundle (8.06 MB) plus assets. Output directory was deleted afterwards |
| `git grep "PRICE\b" -- mobile/src` | Only the assertion `expect(tour.PRICE).toBeUndefined()` in `pricing.test.js`; no constant |
| `git grep -E "(sk\|rk\|pk)_(test\|live)_" -- mobile` | no matches |
| `cd server && npx jest` | 54 suites, 730 tests, all pass (729 at Wave 8 plus the new audit test) |
| `cd server && npm run test:int` | 28 suites, 0 failures (two runs, see below) |

## Server integration

The full `timeout 900 npm run test:int` run hit the 900 s wrapper limit (exit 124) after 23 suites had passed, with no failures; this machine ran the suites serially and slowly (guards 130 s, checkout 98 s). The five suites the wrapper cut off (`checkoutSweep`, `locks`, `review`, `routing`, `seats`) were then run on their own: all pass. Together that is all 28 int suites green, including `adminAuth.int.test.ts` (the suite that exercises the audit-log writer changed in 9.0). No int test asserted the old verbatim-email behaviour.

## Deviations from the plan

- `@testing-library/react-native` is pinned to `^13` with `react-test-renderer@19.1.0`. The latest (14.x) peer-depends on a different `test-renderer` package and no longer uses `react-test-renderer`, so the plan's install line fails with an ERESOLVE on npm. Expo's own docs now say the library replaces `react-test-renderer`; v13 is the last line that still uses it and matches the plan's test code.
- `jest.config.js` sets `testTimeout: 30000`. The existing vault crypto tests generate RSA keys and run PBKDF2 and exceed Jest's 5 s default on this machine.
- `jest.setup.js` additionally mocks `react-native-safe-area-context` with the library's official jest mock (the screens call `useSafeAreaInsets`).
- `billingStore` discards a refresh response that lands after `reset()` (sign-out) using an epoch counter, so a slow in-flight request cannot repopulate the store of the next user. Test added: "discards a response that lands after sign-out (reset)".
- `billingStore.test.js` captures the 402-handler registration at import time because `jest.clearAllMocks()` in `beforeEach` erases the call the plan's version asserts on.
- Portal opens from the paywall, grace banner and subscription screen catch errors (a 409 or network failure shows a message or is ignored) instead of leaving an unhandled rejection.
- `PaywallScreen` clamps the chosen seats to the household's member count even if the plan status arrives after first render.
- Terms and Privacy links also appear on the onboarding pricing screen (next to the disclosure), not only on the paywall.
- Commit trailers use the single Co-Authored-By line requested by the orchestrator, not the plan's two-line trailer.

## Auto-renewal disclosure and legal links

`autoRenewDisclosure` in `mobile/src/shared/billing/pricing.js` is byte-identical to the server's `copy.ts` and is asserted in `pricing.test.js`. It is rendered directly above Subscribe in `PlanPicker` (paywall, change-plan) and on `FeaturePricingScreen`. Terms and Privacy URLs live only in `mobile/src/shared/billing/legalLinks.js` (defaults `https://rootaroo.com/terms` and `https://rootaroo.com/privacy`).

OWNER DECISION NEEDED: confirm both URLs (and the Google Play package in `STORE_SUBSCRIPTION_URLS.google`, `com.rootaroo.app`) before release.

## Task 9.7: Android emulator verification

Outcome: NOT RUN. Requires owner device run.

Environment check:
- `adb`, the emulator, Android platforms and AVDs, and JDK 17 were available locally. No device was attached.
- The walk-through cannot be completed from this environment because it needs a Stripe test-mode API key (`STRIPE_TEST_SECRET_KEY` or a restricted key) with the catalog bootstrapped, plus `stripe listen` forwarding; `server/.env.impl` holds only webhook secrets, not an API key, and keys must not be requested or printed here. This is also the scope of Wave 10 (sandbox end to end).
- A NEW EAS/local development build is required: the deep-link scheme was renamed from `rootaru` to `rootaroo` in Wave 1, so any previously installed dev client will not open `rootaroo://` links. `expo run:android` (or an EAS dev build) must be rerun.

What was verified instead: the Android JS bundle exports without errors (above), and every screen and flow is covered by Jest tests with the Stripe browser step mocked.

Manual checklist (requires owner device run; mark pass/fail, emulator image and build id):

Setup: server `cd server && npm run dev` with test-mode Stripe keys and a bootstrapped catalog; `stripe listen --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test`; Android emulator; `cd mobile && npx expo run:android`. Card 4242 4242 4242 4242, any future expiry, any CVC.

| # | Step | Expected | Result |
|---|---|---|---|
| 0 | `adb shell am start -W -a android.intent.action.VIEW -d "rootaroo://billing/cancel" com.rootaroo.app` | App opens (scheme registered in the new build) | |
| 1 | Fresh household admin finishes onboarding | `FeaturePricingScreen` shows server prices and the auto-renewal disclosure; screenshot 01 | |
| 2 | Not now | Paywall; screenshot 02. Member account on a second emulator user sees `PaywallMemberScreen` with the admin name; screenshot 03 | |
| 3 | Subscribe, 6 members, monthly | Checkout opens (screenshot 04); after paying the app returns and shows MainTabs within 10 s | |
| 4 | Kill network, relaunch | Still MainTabs (last-known status kept); restore network | |
| 5 | More, Subscription | `6 members · monthly`, `$10.98 per month`, renewal date, seats used (screenshot 05); Manage subscription opens the portal (screenshot 06) | |
| 6 | Android back/dismiss during Checkout before paying | "Checkout was not completed." and the app stays on the paywall | |
| 7 | Pay, then dismiss the Custom Tab manually (browser reports `dismiss`) | App still syncs by sessionId and unlocks | |

iOS: see `docs/billing/ios-manual-checklist.md`.
