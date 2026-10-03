# Billing: local testing guide

Manual testing of billing against the throwaway database, with seeded scenarios. No Stripe Dashboard access is needed.

All commands run from the repo root unless stated. Examples use bash (Git Bash on Windows).

## 1. Start the local stack

The throwaway MySQL (`rootaroo-mysql-impl`, host port 3307) and Redis (`rootaroo-redis`) run in Docker. Never use `rootaroo_dev` or port 3306 for this.

```bash
docker ps --format '{{.Names}}  {{.Ports}}'      # expect rootaroo-mysql-impl (3307) and rootaroo-redis

cd server
set -a && . ./.env.impl && set +a                 # loads DB_*, STRIPE_TEST_*, ADMIN_BILLING_API_KEY into this shell
npm run dev                                       # runs migrations, then tsx watch on http://localhost:3000
```

Notes:
- `.env.impl` is not committed. Do not print or paste it. The shell variables it loads (`ADMIN_BILLING_API_KEY`, `STRIPE_TEST_SECRET_KEY`, ...) are what the curl examples below use.
- Run every `curl` below in a shell that has loaded `.env.impl` the same way.
- `NODE_ENV` is not `production`, so every household resolves to billing mode `test` (sandbox Stripe, `livemode=false`).

## 2. Run the seed

```bash
cd server
set -a && . ./.env.impl && set +a
npx tsx scripts/dev/seed-billing.ts --reset 2>&1 | grep -v '^Executing'
```

- Without `--reset` the script refuses to run again if seed data exists (idempotent). `--reset` deletes only seed-tagged rows (households named `[seed] ...`, users `seed+*@rootaroo.test`, provider ids containing `seed`) and recreates them.
- It refuses to run unless `DB_NAME` is `rootaroo_impl` or ends in `_test`, `NODE_ENV` is not `production`, `DB_PORT` is not 3306, and `DB_SOCKET` is unset.
- It writes DB rows directly and clears the Redis entitlement cache, then calls `getEntitlement` for every scenario and prints an expected-vs-actual table. It exits non-zero on a mismatch.
- Time-based fields (periods, `grace_until`) are relative to the moment you seed. Re-run with `--reset` after a few days, or grace and period-end scenarios will drift.

### Scenarios

| Key | Household | Members | Seats | State | Expected |
|-----|-----------|---------|-------|-------|----------|
| A | No subscription | 3 | 5 | none | 402 `SUBSCRIPTION_REQUIRED` (admin and member) |
| B | Active monthly | 5 | 5 | active | allowed, full |
| C | Active yearly | 6 | 7 | active | allowed, 1 seat free |
| D | Active, full | 5 | 5 | active | allowed, join gives 402 `SEAT_LIMIT` |
| E | 10 seats | 10 | 10 | active | allowed, hard cap 10 |
| F | Past due in grace | 5 | 5 | past_due, grace_until +4d | allowed (`grace`) |
| G | Past due, grace expired | 5 | 5 | past_due, grace_until -2d | blocked |
| H | Cancel at period end | 5 | 5 | active, `cancel_at_period_end`, ends +12d | allowed |
| I | Canceled | 5 | 5 | canceled, ended -3d | blocked |
| J | Test cohort, no sub | 3 | 10 | `billing_cohort=test` | allowed (`test_cohort`) |
| K | Pending plan update | 5 | 5 | active, `pending_update` set to 7 seats | allowed, seats unchanged |
| L | Apple IAP | 5 | 5 | active, provider `apple` | allowed |
| M | Google Play | 5 | 5 | active, provider `google` | allowed |
| N | Duplicate subscriptions | 5 | 5 | two active subs, open `duplicate_subscription` review item | allowed |

Also seeded: ledger rows (payments with fee/net, failed payments, a partial refund, a full refund, a pending refund, disputes open/won/lost, one unmatched payment), 4 open and 4 closed review items, one reconciliation run, and 4 webhook events (`evt_seed_processed_1`, `evt_seed_processed_2`, `evt_seed_failed_1`, `evt_seed_dead_1`).

Ids use the prefixes `cus_seed_`, `sub_seed_`, `in_seed_`, `ch_seed_`, `re_seed_`, `dp_seed_`, `evt_seed_`. They do not exist in Stripe, so anything that calls Stripe for them (`/portal`, `/plan` on a Stripe sub, `/reconciliation/run`, replaying a Stripe-calling event) will fail or report drift. That is expected. To test those paths against real Stripe sandbox objects, use hosted Checkout (section 5) with a real test subscription.

## 3. Log in as a seeded user

Login is email and password (`POST /api/v1/auth/login`). Seeded users are email-verified, so no OTP or Google sign-in is needed.

- Admin: `seed+<key>-admin@rootaroo.test` (for example `seed+b-admin@rootaroo.test`)
- Members: `seed+<key>-member1@rootaroo.test`, `member2`, ... (key is the lowercase scenario letter)
- Password: the `SEED_PASSWORD` constant at the top of `server/scripts/dev/seed-billing.ts` (a test-only value shared by all seed users).

Mobile app: start the app pointing at your local server (`EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:3000/api/v1`; see `mobile/.env.example`), then use the normal email/password sign-in screen with one of the accounts above. On a physical device, use your machine's LAN IP, not `localhost`.

Typical checks:
- A admin: paywall shown with purchase options. A member: member paywall (ask an admin to subscribe).
- J: no paywall, even with no subscription.
- D or E: from another account, try to join with the household invite code. The seed prints codes for C, D, E. Expect `SEAT_LIMIT` for D and E, success for C.
- H: status shows cancellation scheduled. F: grace banner. G, I: paywall.

Get a bearer token for curl:

```bash
export API=http://localhost:3000/api/v1
login() { curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$SEED_PW\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data?.tokens?.accessToken ?? j.tokens?.accessToken ?? "")})'; }
# SEED_PW: export it yourself from the seed file's SEED_PASSWORD constant (do not paste it into docs or history files)
TOKEN=$(login seed+b-admin@rootaroo.test)
```

## 4. Staff admin endpoints (`/api/v1/billing-admin`)

Header: `x-admin-billing-key: $ADMIN_BILLING_API_KEY` (from `.env.impl`). Every call is audited in `admin_audit_log`. If `ADMIN_BILLING_IP_ALLOWLIST` is set, your IP must be listed.

**Important:** `mode` defaults to `live`. The seed is all `test` mode, so always pass `mode=test` (or `"mode":"test"` in bodies).

```bash
export API=http://localhost:3000/api/v1
ADM=(-H "x-admin-billing-key: $ADMIN_BILLING_API_KEY")
J=(-H 'Content-Type: application/json')
```

Grab household ids from the seed output table, or:

```bash
curl -s "${ADM[@]}" "$API/billing-admin/subscriptions?mode=test&limit=50" | head -c 2000
export HH_B=<household id of scenario B>   # likewise HH_A, HH_G, HH_J, HH_N ...
```

| Endpoint | Try it on |
|----------|-----------|
| `GET /ping` | any |
| `GET /transactions`, `/transactions.csv`, `/transactions/:id` | B (partial refund), C (open dispute), E (won), G (lost), N (full refund) |
| `GET /summary` | whole ledger (default window is the last 30 days) |
| `GET /subscriptions` | filter `status=past_due`, `canceled`, ... |
| `GET /households/:id` | any, A for "no sub", N for duplicates |
| `GET /reconciliation/runs`, `/reconciliation/items` | seeded run and items |
| `POST /reconciliation/run` | calls real Stripe; seed ids will show as `missing_in_stripe` |
| `POST /reconciliation/items/:id/resolve` | open items |
| `POST /events/:id/replay` | the failed and dead seed events |
| `POST /households/:id/cohort` | A (no sub, switches freely), B (blocked without `force`) |
| `GET /routing`, `PUT /routing` | global |

### Ping

```bash
curl -s "${ADM[@]}" $API/billing-admin/ping
```

### Transactions, CSV, single transaction

```bash
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&limit=20"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&type=refund"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&type=dispute"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&householdId=$HH_B"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&email=seed%2Bb-admin%40rootaroo.test"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&matchStatus=unmatched"
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&billingReason=subscription_cycle&status=failed"
# pagination: pass nextCursor from the previous response
curl -s "${ADM[@]}" "$API/billing-admin/transactions?mode=test&limit=5&cursor=<nextCursor>"
# CSV
curl -s "${ADM[@]}" "$API/billing-admin/transactions.csv?mode=test" -o seed-transactions.csv
# one transaction (use an id from the list)
curl -s "${ADM[@]}" "$API/billing-admin/transactions/<transaction uuid>"
```

Filters: `householdId`, `userId`, `email`, `type` (`payment|failed_payment|refund|dispute`), `status`, `matchStatus`, `billingReason`, `from`, `to` (ISO date-time), `cursor`, `limit` (1-200).

### Summary and subscriptions

```bash
curl -s "${ADM[@]}" "$API/billing-admin/summary?mode=test"
curl -s "${ADM[@]}" "$API/billing-admin/summary?mode=test&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z"
curl -s "${ADM[@]}" "$API/billing-admin/subscriptions?mode=test"
curl -s "${ADM[@]}" "$API/billing-admin/subscriptions?mode=test&status=past_due"
```

### Household billing view

```bash
curl -s "${ADM[@]}" "$API/billing-admin/households/$HH_B"   # cohort, entitlement, subs per mode, customers, members, recent transactions
curl -s "${ADM[@]}" "$API/billing-admin/households/$HH_N"   # duplicates
```

### Reconciliation

```bash
curl -s "${ADM[@]}" "$API/billing-admin/reconciliation/runs?mode=test"
curl -s "${ADM[@]}" "$API/billing-admin/reconciliation/items?mode=test&status=needs_review"
curl -s "${ADM[@]}" "$API/billing-admin/reconciliation/items?mode=test&status=auto_fixed"
# runs a real reconciliation against the Stripe sandbox (uses STRIPE_TEST_SECRET_KEY); 409 LOCK_BUSY if one is running
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"mode":"test"}' $API/billing-admin/reconciliation/run
# resolve or ignore an item (id from the items list)
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"resolution":"resolved","note":"checked locally"}' \
  $API/billing-admin/reconciliation/items/<item uuid>/resolve
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"resolution":"ignored","note":"seed noise"}' \
  $API/billing-admin/reconciliation/items/<item uuid>/resolve
```

### Replay a webhook event

`:id` is the row uuid or the provider event id. The seeded `customer.updated` events are ignored by the handler on replay, so they end as `ignored` rather than failing again.

```bash
curl -s -X POST "${ADM[@]}" $API/billing-admin/events/evt_seed_failed_1/replay
curl -s -X POST "${ADM[@]}" $API/billing-admin/events/evt_seed_dead_1/replay
# 404 for unknown, 409 EVENT_PROCESSING if a worker holds it
```

### Cohort change

```bash
# A has no subscription: switches cleanly (and unblocks the paywall)
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"cohort":"test","reason":"local test"}' $API/billing-admin/households/$HH_A/cohort
# B has an active subscription: 409 COHORT_CHANGE_BLOCKED
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"cohort":"test","reason":"local test"}' $API/billing-admin/households/$HH_B/cohort
# force: sets cancel_at_period_end and expires open sessions (calls Stripe for stripe subs; seed ids will error or raise a review item)
curl -s -X POST "${ADM[@]}" "${J[@]}" -d '{"cohort":"test","reason":"local test","force":true}' $API/billing-admin/households/$HH_B/cohort
```

Run the seed with `--reset` afterward to restore cohorts.

### Routing rules

```bash
curl -s "${ADM[@]}" $API/billing-admin/routing
# replaces ALL rules in one transaction; method: stripe_checkout | apple_iap | google_play | none
curl -s -X PUT "${ADM[@]}" "${J[@]}" -d '{"rules":[
  {"platform":"ios","country":"*","method":"stripe_checkout"},
  {"platform":"android","country":"*","method":"stripe_checkout"},
  {"platform":"web","country":"*","method":"stripe_checkout"}]}' $API/billing-admin/routing
# example: force Apple IAP on iOS everywhere
curl -s -X PUT "${ADM[@]}" "${J[@]}" -d '{"rules":[
  {"platform":"ios","country":"*","method":"apple_iap"},
  {"platform":"android","country":"*","method":"google_play"},
  {"platform":"web","country":"*","method":"stripe_checkout"}]}' $API/billing-admin/routing
```

Negative checks: omit the header (401), use a wrong key (401), send a bad uuid (400).

## 5. User billing endpoints (`/api/v1/billing`)

All need `Authorization: Bearer $TOKEN` (see section 3). Client context headers: `x-platform: ios|android|web` and `x-store-country: US` select the purchase method (see routing).

```bash
H=(-H "Authorization: Bearer $TOKEN")
```

| Endpoint | Household and user | Expect |
|----------|--------------------|--------|
| `GET /status` | B admin (active), F (grace), G/I (blocked), H (cancel scheduled), K (pending update), J (test cohort), N | entitlement, subscription, `purchaseMethod`, flags |
| `GET /plans` | any with a household | price matrix; needs a Stripe sandbox catalog (`npm run billing:bootstrap` in `server/`) or returns 503 `CATALOG_UNAVAILABLE` |
| `POST /checkout` | A admin (or G/I admin) | hosted Checkout URL; member gets 403 |
| `POST /checkout/:sessionId/sync` | A admin after paying | status flips to active |
| `POST /plan` | B admin | calls Stripe for `sub_seed_b`, which does not exist, so expect an error; use a real checkout sub for a true plan change |
| `POST /portal` | B admin | same caveat as `/plan` (needs a real `cus_` in Stripe) |
| `POST /iap/apple/verify`, `/iap/google/verify` | L, M | need real store tokens; see `docs/billing/device-test-checklist.md` |

```bash
TOKEN=$(login seed+b-admin@rootaroo.test)
curl -s "${H[@]}" -H 'x-platform: ios' -H 'x-store-country: US' $API/billing/status
curl -s "${H[@]}" $API/billing/plans

TOKEN_A=$(login seed+a-admin@rootaroo.test)
curl -s -X POST -H "Authorization: Bearer $TOKEN_A" "${J[@]}" -d '{"interval":"month","seats":5}' $API/billing/checkout
# open the returned url in a browser, pay with a test card, then:
curl -s -X POST -H "Authorization: Bearer $TOKEN_A" $API/billing/checkout/cs_test_XXXX/sync

curl -s -X POST "${H[@]}" "${J[@]}" -d '{"interval":"year","seats":7}' $API/billing/plan
curl -s -X POST "${H[@]}" $API/billing/portal
```

Paywall on a guarded route (A should return 402 `SUBSCRIPTION_REQUIRED`, B should return 200):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_A" $API/dashboard
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" $API/dashboard
```

Seat cap: log in as any user not in D (or register a new account), then join with D's invite code (printed by the seed):

```bash
curl -s -X POST -H "Authorization: Bearer <other user token>" "${J[@]}" -d '{"code":"<D invite code>"}' $API/households/join
# expect 402 SEAT_LIMIT
```

### Hosted Checkout with test cards (no Dashboard needed)

`POST /checkout` as household A returns a real Stripe-hosted Checkout URL in the sandbox. Open it in a browser and pay with a test card. This works without Dashboard access, using only the API key in `.env.impl`. After paying, either call `/checkout/:sessionId/sync` or let a forwarded webhook (next section) update the subscription.

Test cards (any future expiry, any CVC, any postal code):

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | succeeds |
| `4000 0025 0000 3155` | requires 3D Secure authentication |
| `4000 0000 0000 0341` | attaches, then renewal payments fail (use for past_due) |
| `4000 0000 0000 9995` | declined, insufficient funds |
| `4000 0000 0000 0002` | declined, generic |
| `4000 0000 0000 0259` | succeeds, then a dispute is created |
| `4000 0000 0000 0077` | succeeds, funds available immediately (balance) |
| `4000 0000 0000 0069` | declined, expired card |

## 6. Trigger webhooks locally (no Dashboard)

The server's webhook endpoint is `POST /api/v1/billing/webhooks/stripe/test`. Verify signatures using the secret printed by `stripe listen`, which must be in `STRIPE_TEST_WEBHOOK_SECRETS` for the running server (add it to `.env.impl` and restart `npm run dev`; the file is never committed).

Authenticate the CLI with the API key instead of `stripe login`:

```bash
# terminal 1: forward events to the local server and print the whsec_ signing secret
stripe --api-key "$STRIPE_TEST_SECRET_KEY" listen --latest \
  --forward-to http://localhost:3000/api/v1/billing/webhooks/stripe/test

# terminal 2: generate sandbox events
stripe --api-key "$STRIPE_TEST_SECRET_KEY" trigger invoice.payment_succeeded
stripe --api-key "$STRIPE_TEST_SECRET_KEY" trigger invoice.payment_failed
stripe --api-key "$STRIPE_TEST_SECRET_KEY" trigger customer.subscription.updated
stripe --api-key "$STRIPE_TEST_SECRET_KEY" trigger charge.refunded
stripe --api-key "$STRIPE_TEST_SECRET_KEY" trigger charge.dispute.created
```

- `--latest` makes the CLI use the newest API version, matching the server's pinned version.
- `stripe trigger` creates its own fixture customers and subscriptions, which are not linked to seeded households, so the ledger records them as `unmatched` and raises review items (`unmatched_invoice`, `unmatched_subscription`). To see a matched event, buy through hosted Checkout (section 5) while `stripe listen` is running.
- Inspect results with `GET /billing-admin/transactions?mode=test`, `/reconciliation/items?mode=test`, and the `billing_events` table. Failed events can be replayed with `POST /billing-admin/events/:id/replay`.

## 7. Resetting and cleaning up

```bash
cd server && set -a && . ./.env.impl && set +a
npx tsx scripts/dev/seed-billing.ts --reset 2>&1 | grep -v '^Executing'
```

`--reset` touches only seed-tagged rows. Rows created by hosted Checkout testing (real `cus_`/`sub_` ids) are left alone; remove them by hand from the throwaway DB if needed.

## Android emulator

On machines with limited RAM, don't run the Gradle build while an emulator is running: the build alone needs a few GB.

**One-time native build (slow the first time because Gradle downloads the NDK; later builds are much faster)**
1. Stop the emulator, Metro and the dev server; keep Docker running.
2. In `mobile/`, regenerate the native project (it is gitignored). `LOCAL_NO_FCM=1` tells `app.config.js` to skip
   `google-services.json` if you don't have it, so push notifications are off in that build:
   ```bash
   export ANDROID_HOME=<your Android SDK path>
   LOCAL_NO_FCM=1 npx expo prebuild --platform android --clean --no-install
   ```
3. Optional low-memory settings in `mobile/android/gradle.properties` (reapply after every prebuild):
   `reactNativeArchitectures=x86_64` (emulator ABI only), `org.gradle.parallel=false`, `org.gradle.workers.max=2`,
   `kotlin.compiler.execution.strategy=in-process`.
4. Some older JDK 17 builds reject the empty classpath in the generated `gradlew.bat` with "-classpath requires class
   path specification". Either use a current JDK 17 or newer, or remove ` -classpath "%CLASSPATH%"` from its last java line.
5. Build: `cd android && ./gradlew app:assembleDebug -x lint -x test -PreactNativeArchitectures=x86_64`
   (on Windows, `gradlew.bat`). The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

**Each test session**
```bash
emulator -avd <your AVD> -no-boot-anim -no-audio -no-snapshot-save
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:3000 tcp:3000   # API and the Checkout return page on localhost:3000
adb reverse tcp:8081 tcp:8081   # Metro
cd server && set -a && . ./.env.impl && set +a && npm run dev
cd mobile && LOCAL_NO_FCM=1 npx expo start --dev-client
```
The app talks to `10.0.2.2:3000` (the emulator's alias for the host) unless `EXPO_PUBLIC_API_URL` is set. In dev,
routing sends every platform to `stripe_checkout`, so the emulator shows the Stripe path. Checkout opens in a Chrome
Custom Tab; on a fresh emulator, finish Chrome's first-run screen once. Store IAP needs a real device with a
Play-signed build (see `device-test-checklist.md`).

**What to try**

| Login (see section 3) | Expect |
|---|---|
| `seed+a-admin` | Paywall shows `/billing/plans` prices. Subscribe opens Stripe Checkout in a browser tab; pay with 4242; it returns through `rootaroo://billing` and the app unlocks after sync |
| `seed+a-member1` | Member paywall ("ask your household admin"), no purchase button |
| `seed+b-admin` | Unlocked. The Subscription screen shows monthly, 5 seats. Manage opens the portal, which fails for seeded fake Stripe ids; use a household bought through Checkout to test the portal |
| `seed+f-admin` | Grace-period state, still usable |
| `seed+g-admin`, `seed+i-admin` | Paywall (grace expired, canceled) |
| `seed+j-admin` | Test cohort: unlocked with no subscription |
| fresh signup | Full flow: create a household, hit the paywall, check out |
