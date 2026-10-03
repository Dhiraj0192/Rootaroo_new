# Billing: overview

Rootaroo charges per household through Stripe (hosted Checkout and the Billing Portal) and, where store rules require it,
through Apple App Store and Google Play in-app purchases. Stripe (or the store) is the source of truth; the server mirrors
state locally and reconciles it.

Source of truth for design decisions: [`docs/superpowers/specs/2026-10-02-billing-stripe-iap-design.md`](../superpowers/specs/2026-10-02-billing-stripe-iap-design.md).
Implementation plan: [`docs/superpowers/plans/2026-10-02-billing-implementation.md`](../superpowers/plans/2026-10-02-billing-implementation.md).
Operations: [`runbooks.md`](./runbooks.md). Evidence index: [`docs/superpowers/evidence/README.md`](../superpowers/evidence/README.md).

Related guides (not duplicated here):
- [`local-testing.md`](./local-testing.md): local stack, seeded scenarios, curl recipes, Android emulator.
- [`device-test-checklist.md`](./device-test-checklist.md): Apple/Google store IAP checklist (real devices).
- [`ios-manual-checklist.md`](./ios-manual-checklist.md): iOS Checkout manual checklist.

## 1. Architecture

Server code lives in `server/src/modules/billing/`.

| Area | Files | Responsibility |
|---|---|---|
| Config and mode | `config.ts`, `mode.ts` | Startup checks, one Stripe client per mode, `resolveMode(household)`, `modeFromLivemode()` |
| Catalog and plans | `catalog.ts`, `plans.ts`, `plan.ts`, `copy.ts` | Price sets by lookup key (cached per mode), `GET /billing/plans`, plan changes |
| Entitlement | `entitlement.ts`, `socketGate.ts` | `getEntitlement()`, `requireEntitlement` (402), seat checks, socket gate |
| Checkout and portal | `checkout.ts`, `checkoutSweep.ts`, `portal.ts`, `returnPage.ts` | Hosted Checkout creation and sync, portal sessions, return page |
| Subscription state | `sync.ts` | `upsertSubscription()`, the only writer of subscription state |
| Webhooks | `webhookRoutes.ts`, `webhooks.ts`, `worker.ts`, `handlers.ts` | Raw-body receiver (verify, persist, 200), in-process worker plus sweep, per-event handlers |
| Ledger | `ledger.ts` | Payments, failed payments, refunds, disputes, fees; household and user linking |
| Reconciliation | `reconcile.ts`, `review.ts`, `alerts.ts`, `priceNotices.ts`, `duplicates.ts` | Daily/weekly drift repair, review queue, alert emails, price-change notices, duplicate-subscription resolution |
| Routing | `routing.ts` | Which purchase method a (platform, country) gets |
| Store IAP | `iap/` | Apple and Google verification, notifications, store reconcile, provider-neutral `store.ts` |
| Staff API | `admin/` | `/api/v1/billing-admin/*` (separate key, audited) |
| Jobs | `server/src/jobs/billing-*.ts` | Event sweep (every minute), checkout sweep (15 min), reconcile (daily 03:30 UTC, weekly Sunday 04:00 UTC), price notices (daily) |
| Scripts | `scripts/stripe-bootstrap.ts` (`npm run billing:bootstrap`) | Catalog, portal configuration, webhook endpoints, price sets, migrations |

Mobile code: `mobile/src/shared/billing/` (plans, gate, purchase, IAP, legal links, countries).

### 1.1 Request flow (Checkout)

1. The app calls `POST /api/v1/billing/checkout` (household admin only). The server ignores any price or quantity from the app:
   it derives seats from the household and prices from the catalog, checks routing and duplicates, and creates a Checkout Session
   (one per household at a time; concurrent calls share one session).
2. The app opens the returned hosted URL in a browser tab. Stripe redirects to `GET /billing/return/:result`, which 302s to the
   `rootaroo://billing/<result>` deep link (with a static HTML fallback; no side effects).
3. The app calls `POST /billing/checkout/:sessionId/sync`, which fetches the session and runs `upsertSubscription()`.
4. `GET /billing/status` returns the entitlement (Redis cache, 60 s, mode-keyed).

### 1.2 Webhook flow

`POST /api/v1/billing/webhooks/stripe/{test|live}` is mounted before the rate limiter and `express.json()` with a raw body.
The server verifies the signature against every configured secret for that mode (300 s tolerance), rejects a `livemode`
mismatch (400), persists the event to `billing_events` (idempotent on event id), answers 200, and the in-process worker then
handles it. A one-minute sweep picks up events stuck in `received`/`processing` or `failed`. Events whose `metadata.env`
differs from `BILLING_ENV_TAG` are marked `ignored`. Apple (`/webhooks/apple`) and Google (`/webhooks/google`) notifications
follow the same persist-then-process shape.

### 1.3 Worker and reconcile flow

All periodic jobs take a named lock (`billing:job:{name}:{mode}`, Redis with MySQL fallback), so several instances are safe.
Daily reconcile re-fetches active/past-due subscriptions, lists recent subscriptions/invoices/refunds/disputes, fills fees, and
auto-fixes drift. Weekly reconcile paginates everything. Differences it cannot fix become `needs_review` items and a summary
email to `ADMIN_EMAIL`. Dead events, or 5+ failed events in 15 minutes, send an immediate alert. Store (Apple/Google)
subscriptions are reconciled by `iap/reconcileStore.ts`.

### 1.4 Entitlement and paywall

`getEntitlement(householdId)` combines cohort, mode, subscription status, grace (`BILLING_GRACE_DAYS`) and seats. Only rows whose
`livemode` equals `resolveMode(household)` count. Guarded routers use `authenticate` then `requireEntitlement` and answer
`402` when blocked; unguarded routes (auth, billing, household basics) keep working. The mobile app shows the paywall from
`/billing/status` and uses `purchaseMethod` (from routing) to choose Stripe Checkout, Apple IAP, Google IAP or "not available".

### 1.5 Routing and IAP providers

The app sends `X-Platform` and `X-Store-Country` (`ZZ` when unknown). Resolution: exact (platform, country), then
(platform, `*`), then none. Test cohort and non-production always allow `stripe_checkout`. Rules are managed with the staff API
(see runbooks). IAP providers: Apple (App Store Server API plus signed notifications) and Google (Play Developer API plus
Pub/Sub RTDN push, OIDC verified). Each is off (503) until its env vars are set.

### 1.6 Test versus live separation

- Modes: `test` (Stripe sandbox, `livemode=false`) and `live`. Outside production every household resolves to `test`.
  In production, households in cohort `test` resolve to `test`, all others to `live`.
- `BILLING_ENV_TAG` (`dev`, `staging`, `prod`) is stamped into `metadata.env` of every Customer, Checkout Session and Subscription;
  objects with a different tag are ignored by the worker and reconcile.
- Webhooks and reconcile take the mode from the endpoint/job (`event.livemode`), never from the household.
- Every billing row stores `livemode`; Redis keys include the mode.
- Startup refuses: live variables outside production, test keys in live variables and vice versa, missing live keys in
  production, `BILLING_ENV_TAG` other than `prod` in production, a too-short `ADMIN_BILLING_API_KEY`.
- Cohorts: `billing_cohort` on the household (`live` default, `test`). Changing it is a staff action (runbook) and is refused
  while an allowed subscription or open checkout exists unless `force`.

## 2. Money flows

```
Checkout Session (completed)
  -> customer.subscription.created/updated   -> upsertSubscription()  (status, period, seats, price set, grace)
  -> invoice.paid / invoice.payment_failed   -> ledger: payment / failed_payment (+ fee from balance transaction)
  -> charge.refunded / refund events         -> ledger: refund rows (negative), original payment status
  -> charge.dispute.*                        -> ledger: dispute rows, funds withdrawn / reinstated, dispute fee
```

- Ledger rows (`billing_transactions`) link each payment to a household and the payer user; unmatched ones appear in the
  review queue and in `GET /billing-admin/transactions?matchStatus=unmatched`.
- `GET /billing-admin/summary`: gross (paid payments) minus refunds minus dispute amounts minus fees minus dispute fees = net;
  MRR is monthly plans plus yearly plans divided by 12.
- Failed renewal: Smart Retries run in Stripe; the household enters grace for `BILLING_GRACE_DAYS`, then is blocked until a
  payment succeeds (card update in the portal).
- Refunds and disputes are issued and answered in the Stripe Dashboard; the server only records them (see runbooks).
- Apple/Google purchases create subscription rows through the provider-neutral store interface; the store settles the money,
  so those purchases are not in the Stripe ledger.

## 3. Environment variables (names only)

Defined in `server/.env.example` (never commit values). Real values live in the gitignored `server/.env`, in a throwaway
`server/.env.impl` for local work, and in the host platform's environment settings for deployed environments.

| Variable | Dev / CI | Staging | Production |
|---|---|---|---|
| `NODE_ENV` | development / test | staging | production |
| `BILLING_ENV_TAG` | `dev` | `staging` | `prod` (required) |
| `STRIPE_TEST_SECRET_KEY` | dev sandbox key | staging sandbox key | prod-test sandbox key (test cohort) |
| `STRIPE_TEST_WEBHOOK_SECRETS` | from `stripe listen` | endpoint secret(s) | endpoint secret(s) |
| `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRETS` | must be unset | must be unset | required |
| `STRIPE_BOOTSTRAP_TEST_KEY`, `STRIPE_BOOTSTRAP_LIVE_KEY` | optional, bootstrap only | optional | optional |
| `BILLING_PUBLIC_BASE_URL` | defaults to `SERVER_BASE_URL` | https origin | https origin (required) |
| `ADMIN_BILLING_API_KEY` (32+ chars), `ADMIN_BILLING_IP_ALLOWLIST` | set for staff API | set | set (allowlist recommended) |
| `BILLING_GRACE_DAYS` | optional | optional | optional |
| `BILLING_REQUIRE_TOS_CONSENT` | may be `false` in a sandbox without a Terms URL | default true | must not be `false` |
| `STRIPE_INTEGRATION_ID` | optional | optional | optional |
| `ADMIN_EMAIL` | alert recipient | alert recipient | alert recipient |
| `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`, `APPLE_BUNDLE_ID`, `APPLE_APP_APPLE_ID` | optional | optional | set to enable Apple IAP (`APPLE_APP_APPLE_ID` required) |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_RTDN_AUDIENCE`, `GOOGLE_PLAY_RTDN_SA_EMAIL` | optional | optional | set together to enable Google IAP |

Mobile: no Stripe keys. `EXPO_PUBLIC_API_URL` (see `mobile/.env.example`) points the app at the API.
Integration tests ignore Stripe keys from the environment and install a mock client.

## 4. Local development

See [`local-testing.md`](./local-testing.md): Docker MySQL and Redis, `.env.impl` loading, `npm run dev`, seeded scenarios,
`stripe listen --latest --all-snapshot ...`, Android emulator. Use a throwaway database, never a shared dev one.

## 5. Running each test layer

Run targeted files, not whole suites, on constrained machines. All commands from `server/` unless noted.

| Layer | Command | Notes |
|---|---|---|
| Type check | `npx tsc --noEmit` | |
| Lint | `npm run lint` | 0 errors required (warnings exist) |
| Unit (server) | `npx jest src/modules/billing` | Stripe mocked; pass explicit paths for single files |
| Integration | `set -a && . ./.env.impl && set +a && npm run test:int -- src/modules/billing/__int__/<file>.int.test.ts` | Real MySQL, in band. The harness forces `NODE_ENV=test` and the DB name to `DB_NAME_TEST` (default `rootaroo_test`) and refuses any name not ending in `_test`. `globalSetup` runs the migrations first, so a fresh empty `rootaroo_test` works. |
| Coverage | `npm run test:billing-coverage` | Heavy; needs several GB of heap |
| End to end | `npx tsx scripts/e2e/hosted.ts`, `npx tsx scripts/e2e/lifecycle.ts` | Needs a running dev server, a sandbox Stripe test key, and `stripe listen`; writes JSON to `docs/superpowers/evidence/e2e/`. Env: `E2E_BASE_URL`, `E2E_SERVER_LOG` |
| Mobile | `cd mobile && npx jest src/shared/billing` | |
| Store IAP | [`device-test-checklist.md`](./device-test-checklist.md) | Real devices only |

## 6. Known limitations and open items

- Adaptive Pricing: Checkout can show prices in the buyer's local currency. If the product must always show the catalog
  currency, consider creating sessions with `adaptive_pricing.enabled=false`.
- Hosted Checkout opens in a browser tab by design (store-policy reasons). Stripe PaymentSheet is a possible follow-up.
- Store IAP (Apple/Google) can only be fully verified on real devices with sandbox/test accounts.
- Subscriptions created on Stripe test clocks are not visible to reconciliation; the e2e scripts cover them directly.
- `stripe listen` needs `--all-snapshot` (plus `--latest`) to forward the snapshot events the server expects.
- IAP integration suites can be slow or flaky when run together under memory/CPU pressure; run them one file at a time.
- Release-gate items still open before launch are in spec section 15 and in the going-live checklist in [`runbooks.md`](./runbooks.md).
