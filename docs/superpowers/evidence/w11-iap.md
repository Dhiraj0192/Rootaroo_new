# Wave 11 - Store IAP (Apple App Store, Google Play)

Commits: b2876df2 (provider-neutral store interface, upsertStoreSubscription), a8712186 (Apple notifications, verify endpoint), 078b7716 (Google RTDN, verify, acknowledge), ede818c6 (store reconcile, cohort --force item), 42e15b49 (mobile expo-iap behind purchaseMethod), 6953d6a8 (device checklist). No code fixes were needed in this pass.

## Libraries (package.json)
- server: @apple/app-store-server-library ^3.1.0, google-auth-library ^11.1.0, jose ^6.2.10, jsonwebtoken ^9.0.0
- mobile: expo-iap 5.8.2

## Int-test findings
The earlier failures (apple 434 s, google 202 s, reconcileStore 104 s, VERIFICATION_FAILURE logs) did not reproduce. Tests already mock at the boundary: Apple roots injected via __setAppleRootsForTests, appleOnlineChecks=false in test config, Apple/Play API clients stubbed. No real network calls. Each test pays a resetDb + drain cost that is slow on a loaded machine; the "[IAP] ... VERIFICATION_FAILURE" log lines are the expected negative-path tests (bad signature / foreign chain). Production keeps online checks on (appleOnlineChecks from config).

## Targeted results
- server int apple.int: 27/27, 362 s
- server int google.int: 29/29, 109 s
- server int reconcileStore.int: 5/5, 56 s
- server unit src/modules/billing/iap: 3 suites, 55/55, 255 s
- mobile jest src/shared/billing: 5 suites, 68 passed, 1 skipped, 23 s
- server tsc --noEmit: clean

## Fixture-only vs needs-device
- Fixture-only (verified): Apple JWS chain/notification handling and verify endpoint with a synthetic CA chain; Google RTDN Pub/Sub JWT auth, Play API responses via stubs; reconcile; mobile purchase logic with mocked expo-iap.
- Needs device/owner (see the device checklist): real Apple sandbox and TestFlight purchases, App Store Server API credentials and online certificate checks, Google Play license-tester purchases, real Pub/Sub push, expo-iap native flows.
