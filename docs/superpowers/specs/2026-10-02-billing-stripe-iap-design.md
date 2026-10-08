# Rootaroo Billing: Stripe + In-App Purchase. Design Spec

- **Status:** Draft v2, revised after adversarial review. Pending owner approval.
- **Date:** 2026-10-02
- **Branch:** `feat/billing`
- **Scope:** Phase 0 (deep-link scheme rename), Phase 1 (Stripe), Phase 2 (Apple IAP) and Phase 3 (Google Play Billing). **One release gate:** phases are built and tested in order, each with its own implementation plan, but nothing reaches production until all four have passed. Phases 0–1 are specified in full. Phases 2–3 are specified at the level of contracts and data model (§16), and each gets a detailed addendum when its plan is written.

---

## 1. Goal and success criteria

Household admins pay for Rootaroo. The server enforces a hard paywall. Test and live billing are fully separate. Rootaroo staff can see every transaction, and which user and household it belongs to, through an admin API without opening the Stripe Dashboard.

Phase 1 is done when all of these hold:

1. An admin can subscribe through Stripe Checkout (test mode), return to the app, and be unlocked. Access depends only on verified Stripe data.
2. A household without entitlement gets `402` on every guarded route, its background jobs are skipped, and the app shows the paywall.
3. Every scenario in §13.3 passes end to end against Stripe test mode with test clocks.
4. Every money movement appears in `billing_transactions`, linked to a household and user, and can be queried through the staff API.
5. Reconciliation finds deliberately planted mismatches and either fixes them automatically or flags them for review.
6. Test and live share no keys, secrets, prices or rows, and a test payment can never unlock a live household.

### Decisions already made

| Topic | Decision |
|---|---|
| Rates (official) | USD. Base plan **$8.99/month** or **$79.99/year** for **5 members**, plus **$1.99/month** ($23.88/year) **per extra member**, up to **10 members**. No trial. |
| Price model | **One price per household size** (§6.1): six products (5 to 10 members), each with a monthly and a yearly price. Every subscription has a single line item. The same 12 sizes are used as Apple and Google products. |
| Payment UI | Stripe-hosted Checkout plus the Customer Portal, opened with `expo-web-browser` `openAuthSessionAsync`. |
| Platforms | Stripe Checkout, Apple IAP and Google Play Billing. Which one a user sees is decided by **server-side routing rules** per platform and country, which staff can change without an app release. Production launch rules: US → `stripe_checkout`; iOS elsewhere → `apple_iap`; Android elsewhere → `google_play`. |
| Paywall | Hard paywall, with a 7-day grace period after a failed renewal. Data is never deleted because a household hasn't paid. |
| Cohorts | A `billing_cohort` per household: `live` (the default) or `test`. A `test` household skips the paywall and uses a Stripe **test** sandbox, even in production. Only staff can change it, through the staff API. |
| Price changes | A new price set takes over new checkouts by moving its lookup keys. Existing subscribers **keep their price by default**. Moving them to a new price is a deliberate staff action with at least 30 days' notice, applied before their next renewal. |
| Admin | API only for now, documented in OpenAPI. A separate admin app is a later sub-project. |
| Deep-link scheme | `rootaru` → `rootaroo` everywhere, with **no** support kept for the old spelling (the app isn't live yet). |

---

## 2. Phase 0: rename the deep-link scheme

A single commit that can be reverted on its own. It ships in the same native build as billing.

| Location | Change |
|---|---|
| `mobile/app.json` `"scheme"` | `"rootaru"` → `"rootaroo"` |
| `HouseholdSetupScreen.jsx` (`JOIN_LINK_RE` + comment) | `rootaroo://join?code=` |
| `HouseholdSettingsScreen.jsx:81`, `InviteMembersScreen.jsx:41` | `rootaroo://join?code=` |
| `server/src/modules/household/service.ts:149` `shareLink` + its test | `rootaroo://join?code=` |
| Storage keys in `authPersist.js`, `signupProgress.js` and `dailyWelcomePersist.js` | `rootaroo_*`. Dev testers will be signed out once. |
| `calendar/service.ts:374` UID `@rootaru` | `@rootaroo`. Calendars synced in dev will show each event twice, once. |
| `calendar/controller.ts:62` filename, `restart-dev.sh`, `docs/auth-documentation.html` | Rename |

Done when `git grep -nE "rootaru([^o]|$)"` returns nothing. Needs a new EAS dev-client build.

---

## 3. Architecture

```
Mobile app                         API server (Express)                                  Stripe sandbox/live
──────────                         ────────────────────                                  ───────────────────
Paywall / SubscriptionScreen ────► POST /billing/checkout ──────────────────────────────► Checkout Session
openAuthSessionAsync(url) ──────────────────────────────────────────────────────────────► Hosted Checkout
                                   GET /billing/return/:result   ◄─────── redirect ───── (success|cancel|portal)
rootaroo://billing/<result> ◄───── 302 + static HTML fallback (no side effects)
POST /billing/checkout/:id/sync ─► fetch session → upsertSubscription()
                                   POST /billing/webhooks/stripe/{test|live}  ◄────────── signed events
                                     verify → persist → 200 → worker → upsertSubscription() / ledger
GET /billing/status ─────────────► getEntitlement()   (Redis 60 s cache, mode-keyed)
Guarded routers ─────────────────► authenticate → requireEntitlement → 402
                                   Jobs (all locked): event worker sweep · checkout sweep · reconciliation · price notices
Staff (billing key) ─────────────► /api/v1/billing-admin/*
```

New server module `server/src/modules/billing/`:

| File | Responsibility |
|---|---|
| `config.ts` | Loads keys for each mode, checks them at startup (§4.2), and builds one `Stripe` client per mode. Pins API version `2026-09-30.endive` and SDK `stripe@23.x`. Exposes the env tag. |
| `mode.ts` | `resolveMode(household)`; `modeFromLivemode(bool)` |
| `catalog.ts` | Price sets loaded by lookup key and cached per mode (10 min, cleared through Redis pub/sub); `GET /billing/plans` |
| `entitlement.ts` | `getEntitlement()`, the `requireEntitlement` middleware, `isEntitledBatch()` for jobs, seat checks |
| `checkout.ts` | Checkout create and sync, the portal, `changePlan` (size and interval) |
| `sync.ts` | `upsertSubscription(subId, mode)`, the **only** code that writes subscription state |
| `ledger.ts` | Ledger writes and linking each payment to a household and user |
| `webhooks.ts` | Raw-body receiver: verify, persist, acknowledge |
| `worker.ts` | Processes stored events (in-process queue plus a sweep) |
| `reconcile.ts` | Reconciliation runs and their items |
| `routing.ts` | Routing rules |
| `locks.ts` | Named locks (Redis `SET NX PX`, falling back to MySQL `GET_LOCK`) |
| `admin/*` | The staff API (§11) |
| `jobs/billing-*.ts` | Event sweep, checkout sweep, reconciliation, price notices |
| `scripts/stripe-bootstrap.ts` | Creates the catalog, portal configuration and webhook endpoints, and can be re-run safely. Also `--set-prices`, `--backfill`, `--migrate-prices`. |

---

## 4. Keeping test and live separate

### 4.1 Stripe environments

| Environment | Server | Stripe |
|---|---|---|
| Local dev, CI | `NODE_ENV=development` / `test` | **Sandbox "rootaroo-dev"**: the test key supplied during design |
| Staging (if any) | `NODE_ENV=staging` | Sandbox "rootaroo-staging" |
| Production, test cohort | `NODE_ENV=production` | **Sandbox "rootaroo-prod-test"** (separate from dev, so dev `stripe listen` traffic never reaches production) |
| Production, live cohort | `NODE_ENV=production` | **Live mode** |

As a second guard, every Stripe object we create (Customer, Checkout Session, Subscription via `subscription_data.metadata`) carries `metadata.env = BILLING_ENV_TAG` (`dev`, `staging` or `prod`). The worker and reconciliation mark any object whose `env` tag doesn't match as `ignored`.

### 4.2 Environment variables and startup checks

```
BILLING_ENV_TAG=dev|staging|prod
STRIPE_TEST_SECRET_KEY        sk_test_… | rk_test_…
STRIPE_TEST_WEBHOOK_SECRETS   whsec_…[,whsec_…]   (comma list, so a secret can be rotated without downtime)
STRIPE_LIVE_SECRET_KEY        sk_live_… | rk_live_…   (production only)
STRIPE_LIVE_WEBHOOK_SECRETS   whsec_…[,whsec_…]       (production only)
BILLING_PUBLIC_BASE_URL       https origin used for Checkout return URLs
ADMIN_BILLING_API_KEY         staff key for /billing-admin (≥32 chars)
ADMIN_BILLING_IP_ALLOWLIST    optional CIDR list
BILLING_GRACE_DAYS=7
STRIPE_INTEGRATION_ID=rootaroo_app_checkout_<8 letters, fixed>
```

The server refuses to start if:
- a test variable holds a key that isn't a test key, or a live variable holds a key that isn't a live key;
- `NODE_ENV !== 'production'` and any `STRIPE_LIVE_*` variable is set;
- it's production and the live key or webhook secrets are missing;
- it's production and `BILLING_ENV_TAG !== 'prod'`;
- `ADMIN_BILLING_API_KEY` is shorter than 32 characters while billing-admin is enabled.

If the test key is missing, test mode is turned off: test-cohort households still skip the paywall, but checkout returns `503 BILLING_MODE_UNAVAILABLE`, and a warning is logged.

The logger redacts `/(sk|rk)_(test|live)_\w+|whsec_\w+/`. The mobile app gets **no Stripe keys at all**.

### 4.3 Choosing the mode

```
resolveMode(household):
  NODE_ENV !== 'production'           → 'test'
  household.billing_cohort == 'test'  → 'test'
  otherwise                           → 'live'
```

Webhooks and reconciliation **never** resolve the mode from the household. They take it from the endpoint or job (`event.livemode`). Every billing row stores `livemode`. Entitlement only counts rows whose `livemode` matches `resolveMode(household)`. Redis keys always include the mode (`billing:ent:{mode}:{householdId}`, `billing:catalog:{mode}`).

### 4.4 Webhook endpoints

- `POST /api/v1/billing/webhooks/stripe/test` and `/live`. **Mounted in `app.ts` before the general rate limiter and before `express.json()`**, with `express.raw({type:'application/json', limit:'1mb'})`. These endpoints are not rate limited.
- The signature is checked against each secret configured for that mode (`constructEvent`, 300-second tolerance).
- An event whose `livemode` doesn't match the endpoint is rejected with `400`.
- The bootstrap script registers both endpoints, each subscribed only to the events listed in §8.5.

### 4.5 Keeping secrets out of the repo

- Real values exist only in the gitignored `server/.env` and in Railway's environment variables.
- A Husky pre-commit hook blocks `/(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/`.
- `.env.example` lists every variable name with an empty value.
- Before launch: create a **restricted key** (`rk_`) per environment with the permissions in §14, and **roll** the `sk_test` key that was pasted into chat during design.

---

## 5. Data model

All tables are created by migrations (`server/src/database/migrations/2026100x-*`), with UUID primary keys and `created_at` / `updated_at`. **Every billing model sets `paranoid: false`**. All billing lookups of `Household` or `User` use `paranoid: false`. Amounts are integers in cents.

### 5.1 `households` (new column)
`billing_cohort ENUM('live','test') NOT NULL DEFAULT 'live'`

### 5.2 `billing_customers`
- Columns: `id, household_id, provider ENUM('stripe','apple','google'), livemode, provider_customer_id, billing_email`.
- UNIQUE `(household_id, provider, livemode)`; UNIQUE `(provider, livemode, provider_customer_id)`.
- Foreign keys use `ON DELETE RESTRICT`. Households are only soft-deleted, so this never fires in normal use.

### 5.3 `billing_subscriptions`
`id, household_id, provider, livemode, provider_subscription_id,
status ENUM('incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused'),
interval ENUM('month','year'), seats TINYINT (5..10), price_id, price_set VARCHAR(32), unit_amount INT, currency CHAR(3),
current_period_start, current_period_end   -- taken from items.data[0].current_period_* (current API version)
cancel_at_period_end, canceled_at, ended_at,
pending_update JSON NULL, grace_until NULL, purchased_by_user_id NULL (SET NULL),
event_watermark BIGINT NULL  -- newest event.created applied (tie-breaker only)
last_synced_at`
- UNIQUE `(provider, livemode, provider_subscription_id)`; INDEX `(household_id, livemode, status)`.

### 5.4 `billing_checkout_sessions`
- Columns: `id (also used as the idempotency key), household_id, livemode, provider_session_id UNIQUE NULL, created_by_user_id, interval, seats, status ENUM('creating','open','complete','expired','failed'), url, expires_at`.
- The checkout lock (§8.1) ensures there is at most one `open` or `creating` row per `(household_id, livemode)`.

### 5.5 `billing_events`
`id, provider, livemode, provider_event_id UNIQUE, type, payload JSON, status ENUM('received','processing','processed','failed','ignored','dead'), attempts, locked_at, last_error, received_at, processed_at`

### 5.6 `billing_transactions` (ledger)

Columns:
```
id, provider, livemode,
type ENUM('payment','failed_payment','refund','dispute'),
status VARCHAR(32), billing_reason VARCHAR(40) NULL,
amount INT, fee INT NULL, net INT NULL, dispute_fee INT NULL, currency CHAR(3),
household_id NULL, user_id NULL, subscription_id NULL,
match_status ENUM('matched','unmatched'),
household_name_snapshot, payer_email_snapshot,
provider_object_id NOT NULL, provider_invoice_id NULL, provider_charge_id NULL,
receipt_url NULL, description, occurred_at, last_event_id NULL
```

- **Identity:** UNIQUE `(provider, livemode, type, provider_object_id)`. `provider_object_id` is the invoice ID for `payment` and `failed_payment`, the refund ID (`re_…`) for `refund`, and the dispute ID (`dp_…`) for `dispute`. Each row is updated as its object changes: refund status, and dispute status with funds withdrawn or reinstated.
- **Indexes:** `(livemode, occurred_at)`, `(household_id, occurred_at)`, `(user_id)`.
- **Signs:** all amounts are positive. `type` gives the direction, and summaries do the arithmetic (§11).

### 5.7 `billing_routing_rules`
- Columns: `platform ENUM('ios','android','web'), country CHAR(2) | '*', method ENUM('stripe_checkout','apple_iap','google_play','none'), updated_by, updated_at`.
- UNIQUE `(platform, country)`.
- Seeded by migration: dev/staging `(*,'*') → stripe_checkout`. Production launch: `(ios,'US') → stripe_checkout`, `(android,'US') → stripe_checkout`, `(ios,'*') → apple_iap`, `(android,'*') → google_play`, `(web,'*') → stripe_checkout`.

### 5.8 `billing_price_notices`
`id, subscription_id, from_price_id, to_price_set, notice_sent_at, apply_after, applied_at NULL, status ENUM('scheduled','applied','skipped','failed'), reason`

### 5.9 Reconciliation tables
- **`billing_reconciliation_runs`:** `id, livemode, kind ENUM('daily','weekly','manual'), started_at, finished_at, status, counts JSON`.
- **`billing_reconciliation_items`:** `id, run_id NULL, livemode, kind, entity_type, entity_id, provider_object_id, before JSON, after JSON, resolution ENUM('auto_fixed','needs_review','resolved','ignored'), resolved_by, resolution_note, resolved_at`. `run_id` is NULL for items raised directly by the worker.

### 5.10 `admin_audit_log`
`id, surface ('admin'|'billing-admin'), key_label, method, path, query JSON, body_digest, status_code, ip, created_at`

### 5.11 Privacy and account deletion
Hook: `finalizeUserDeletion` in `server/src/modules/auth/service.ts`, which runs after the 30-day window. It's a soft delete. In the same flow:
1. **Ledger:** set `user_id = NULL` and `payer_email_snapshot = 'deleted user'` on that user's ledger rows. Rows are kept for 7 years for tax purposes, as the draft Privacy Policy §9 says.
2. **Subscriptions:** if the user is `purchased_by_user_id` on a subscription that's allowed, call `subscriptions.update({cancel_at_period_end: true})`, because the card on file is theirs. Set `purchased_by_user_id = NULL`. Notify the remaining admins in the app and by email ("Resubscribe before {date} to keep access"). Update the Stripe customer email to a remaining admin, or clear it if there's none.
3. **Admin role transfer:** `transferAdmin` and `changeMemberRole` update `billing_customers.billing_email` and call `customers.update({email})` for each mode with a customer. This runs after the database commit; if it fails, it's retried by the reconciliation drift check.

---

## 6. Catalog and price changes

### 6.1 Products and prices (identical in each sandbox and in live; created by `stripe-bootstrap.ts`)

| Product (one per size) | Monthly price, lookup key `rootaroo_hh{N}_month` | Yearly price, lookup key `rootaroo_hh{N}_year` |
|---|---|---|
| Rootaroo Household: 5 members | $8.99 (899) | $79.99 (7999) |
| …: 6 members | $10.98 (1098) | $103.87 (10387) |
| …: 7 members | $12.97 (1297) | $127.75 (12775) |
| …: 8 members | $14.96 (1496) | $151.63 (15163) |
| …: 9 members | $16.95 (1695) | $175.51 (17551) |
| …: 10 members | $18.94 (1894) | $199.39 (19939) |

- **Formulas:** monthly = 899 + 199 × (N − 5); yearly = 7999 + 2388 × (N − 5).
- **Metadata:** every price carries `metadata.price_set` (for example `2026-10`), `metadata.seats` and `metadata.interval`. Every product carries `metadata.seats`.
- **Tax:** prices are `tax_behavior: 'exclusive'`. `automatic_tax` stays off until the launch decision in §15.

### 6.2 `GET /api/v1/billing/plans`
- Returns the household's mode, current price set, currency, `seatsIncluded: 5`, `seatsMax: 10`, and the matrix `{ [interval]: { [seats]: { priceId?, amount } } }`.
- The app calculates every displayed figure from this. **The `PRICE` constant is removed from `featureTourContent.js`.**
- For IAP platforms, the app shows the store's own localized prices for the matching product IDs (§16).

### 6.3 Changing prices for new customers
`stripe-bootstrap.ts --mode <env> --set-prices <price_set> --month-base --month-extra --year-base --year-extra`:
1. Creates all 12 new prices, tagged with the new `price_set`, using `transfer_lookup_key: true`.
2. Publishes a catalog cache-bust.

Live mode also needs `--confirm-live`.

### 6.4 Moving existing subscribers to a new price (optional)
`--migrate-prices --from <set> --to <set> --notice-days 30`:
1. **Notices.** For each allowed subscription on `from`: insert a `billing_price_notices` row with `apply_after = notice_sent_at + notice_days`, then send an email (Resend) and an in-app notification to the household's admins showing the old and new price and the effective renewal date.
2. **Daily job (locked).** For each `scheduled` notice where `now ≥ apply_after` **and** `now ≤ current_period_end − 48h`:
   - swap the subscription's single item to the `to`-set price for the **same seats and current interval**, with `proration_behavior:'none'`, so the change takes effect from the next invoice;
   - mark the notice `applied`.

   Notices still waiting less than 48 hours before renewal roll over to the following period. A subscription that is cancelled or ends while a notice is pending is marked `skipped`. A seat or interval change during the notice period re-targets the same `to` set automatically, because `changePlan` (§8.3) picks prices from the `to` set whenever a scheduled notice exists.

### 6.5 Grandfathering when a plan changes
`changePlan` picks the target price from the subscription's **current `price_set`**, provided that price is still `active`. Otherwise it uses the current lookup key. A grandfathered subscriber who adds a member therefore stays on the old price set.

---

## 7. Entitlement and paywall

### 7.1 `getEntitlement(householdId)`

Returns `{ allowed, reason, mode, subscription?, graceUntil?, seatsAllowed }`. Rules, in order:

1. `billing_cohort == 'test'` → allowed (`test_cohort`), `seatsAllowed = 10`.
2. Find the newest subscription for `(household, mode)` whose status is `active`, `trialing` or `past_due`:
   - `active` or `trialing` → allowed (`active`).
   - `past_due` and `now < grace_until` → allowed (`grace`).
   - anything else, or none → **not allowed** (`subscription_required`), `seatsAllowed = 5`.
3. For an allowed subscription, `seatsAllowed = subscription.seats`.

**Grace is computed only in `upsertSubscription`.**
- When it sees `status == 'past_due'` and `grace_until IS NULL`, it sets `grace_until = (latest_invoice.status_transitions.finalized_at ?? latest_invoice.created) + BILLING_GRACE_DAYS`, using Stripe's timestamps.
- Any other status clears `grace_until`.
- `unpaid` and `canceled` block immediately.

Failed proration invoices from plan changes don't change the subscription's status (`pending_if_incomplete`), so they never start a grace period.

**Cache:** `billing:ent:{mode}:{householdId}`, 60-second TTL. It's cleared by every `upsertSubscription`, every cohort change, and every membership change. If Redis is down, the database is read directly.

### 7.2 Server enforcement

`requireEntitlement` is added **inside each guarded router, after `authenticate`**:
1. It looks up the caller's membership.
2. No household → `403 NO_HOUSEHOLD`.
3. Not allowed → `402 { success:false, code:'SUBSCRIPTION_REQUIRED', reason, isAdmin }`.

**Guarded:** feed, tasks, groceries, todos, expenses, vault, events, chat, checkins, pings, places, journal, dashboard, weather, and `notifications/history` (with its read and read-all routes).

**Not guarded:**
- auth, including account deletion
- households: setup, join, leave, settings, invites, members (subject to seats, §7.3)
- billing
- notification `tokens`, `preferences`, `unread-count`
- admin and billing-admin

**`calendar-feed`** (the ICS token feed) returns a valid **empty** calendar for a household that isn't allowed.

**Sockets:**
- On connect, the server caches entitlement for 60 seconds on the socket.
- Every `chat:*` and `presence:*` handler (`typing`, `stop-typing`, `read`, `online`) is ignored while the household isn't allowed.
- Server-side emits to a blocked household's room are skipped.

**Background jobs:** `calendar-sync`, `event-reminder`, `overdue-points` and `grocery-archive` filter households with `isEntitledBatch()`. The purge jobs and the billing jobs don't.

**`/uploads`:** a local-disk static folder used only in development (S3 in production). Startup asserts that `UPLOAD_DIR` static serving is turned off when `NODE_ENV=production`.

### 7.3 Seats
- `joinViaCode` and every member-add path check `memberCount < seatsAllowed` **inside their existing transaction**:
  - seats are read from `billing_subscriptions` there, not from the cache;
  - the household row is locked with `SELECT … FOR UPDATE`;
  - the transaction is retried up to 3 times on `ER_LOCK_DEADLOCK`.
- Otherwise the response is `402 SEAT_LIMIT`.
- A test-cohort household's limit is 10. **The hard cap is 10 members for everyone.**

### 7.4 Mobile
- **Status call:** `GET /billing/status` runs on launch, on returning to the foreground, after returning from checkout or the portal, and after a 402. It returns:
  ```
  { entitlement, subscription, isAdmin, adminNames, purchaseMethod, plans, pendingCheckout: { sessionId, state } | null }
  ```
- **State:** a Zustand `billingStore`, with the last-known status persisted.
  - Network errors **don't** change the gate; the app keeps using the last-known status.
  - The axios interceptor sends any `402` to a **single-flight** `refresh()`, so a burst of concurrent 402s triggers one fetch.
- **`RootNavigator`:** a signed-in household member whose entitlement isn't allowed gets `PaywallStack` instead of `MainTabs`.
  - Admin → `PaywallScreen`: interval toggle, size stepper (minimum is the current member count), total, and an **auto-renewal disclosure** next to the button ("Renews automatically at $X per {month|year} until cancelled. Cancel anytime in Manage subscription."), plus Subscribe, Restore purchases, Terms and Privacy.
  - Member → `PaywallMemberScreen`: "Ask {admin names} to renew", with a Retry button.
- **Grace:** a banner in `MainTabs` with "Fix payment", which opens the portal.
- **Onboarding:** `FeaturePricingScreen` starts the purchase flow for the routed method. `finish()` runs once entitlement is confirmed, or on "Not now", after which the paywall shows.
- **More → Household → Subscription** (`SubscriptionScreen`): plan, renewal date, the price actually paid, seats used/allowed, provider, and the actions **Manage subscription** (Stripe portal, or the App Store / Play subscription page), **Change plan** (size and interval; Stripe only, §8.3), and **Restore purchases**.

---

## 8. Purchase flow, webhooks and edge cases

### 8.1 `POST /api/v1/billing/checkout`

Body (Zod-validated): `{ interval: 'month'|'year', seats: 5..10 }`. The return scheme is fixed at `rootaroo` on the server.

1. Caller must be authenticated and an **admin** of their household, otherwise `403`. `mode = resolveMode(household)`. If the mode is unavailable, `503`.
2. The routed method for the caller (§12) must be `stripe_checkout`, otherwise `409 PURCHASE_METHOD_MISMATCH`.
3. **Acquire the named lock `billing:checkout:{householdId}:{mode}`** (TTL 60 s). No database transaction is held across network calls.
4. **Stale state check (local and Stripe):**
   - (a) If there's a local allowed subscription → `409 ALREADY_SUBSCRIBED`.
   - (b) If the customer exists, call `subscriptions.list({customer, status:'all', limit:10})`:
     - an `active` or `trialing` subscription → run `upsertSubscription` on it, then `409 ALREADY_SUBSCRIBED`;
     - a `past_due` or `unpaid` subscription → `409 PAYMENT_ISSUE` with a portal URL so the user pays the open invoice or updates their card. A second subscription is never created alongside a failing one.
5. **Seats:** if `seats < current member count` → `409 SEATS_BELOW_MEMBERS {memberCount}`.
6. **Reuse:** if an `open` checkout row exists for (household, mode) and hasn't expired:
   - same interval and seats → return its URL;
   - different → `checkout.sessions.expire`. If that fails because the session is already `complete`, sync it and return `409 ALREADY_SUBSCRIBED`.
7. **Customer:** find or create it.
   - Look up the `billing_customers` row. If there's none, run `customers.search("metadata['householdId']:'<id>' AND metadata['env']:'<tag>'")` to recover a customer whose local row was lost.
   - If neither finds one, `customers.create` with idempotency key `cust:{householdId}:{mode}:{adminUserId}`, `email`, and `metadata {householdId, env}`.
   - Insert the row. On a unique conflict, read the existing row again.
8. **Session:** insert a `billing_checkout_sessions` row (`creating`) and use its `id` as the idempotency key. Then call `checkout.sessions.create` with:
   - `mode:'subscription'`, `customer`, `client_reference_id: householdId`
   - `line_items: [{ price: priceFor(currentSet, interval, seats), quantity: 1 }]`
   - `subscription_data.metadata: { householdId, purchasedByUserId, env }`, `metadata: { householdId, env }`
   - `origin_context:'mobile_app'`, `expires_at: now + 31 min` (Stripe's minimum is 30 min), `allow_promotion_codes:false`
   - `consent_collection: { terms_of_service: 'required' }` (needs the Terms URL set in the Dashboard's public business details)
   - `custom_text.submit.message`: the auto-renewal disclosure
   - `success_url: {BILLING_PUBLIC_BASE_URL}/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}`, `cancel_url: …/return/cancel`
   - `integration_identifier: STRIPE_INTEGRATION_ID` (a constant)
   - **no** `payment_method_types`
9. Update the row to `open` with its URL and session ID, release the lock, and return `{ url, sessionId }`. If the Stripe call fails, the row becomes `failed`.

### 8.2 Returning to the app

**`GET /api/v1/billing/return/:result`**
- `:result` is one of `success`, `cancel` or `portal`, and `session_id` must match `^cs_(test|live)_[A-Za-z0-9]+$`. Anything else gets a static page.
- It is public, has no side effects, and grants nothing.
- It returns a `302` to `rootaroo://billing/<result>[?session_id=…]`, with a static HTML fallback ("Return to Rootaroo"). The fallback has a plain link and no inline script, so it complies with helmet's CSP.

**In the app**
- The app keeps the `sessionId` from the checkout response and opens the session with `openAuthSessionAsync(url, 'rootaroo://billing')`.
- **Whatever the result** (`success`, `cancel` or `dismiss`; Android often reports `dismiss` even after a successful payment), the app calls `POST /billing/checkout/:sessionId/sync`.

**`sync`**
- Fetches the session in the household's mode, expanding `subscription`.
- Checks that `client_reference_id` is the caller's household, that `customer` is that household's customer for this mode, and that the caller is a member. Any mismatch → `403`.
- If `status == 'complete'` → `upsertSubscription`. If `expired` → marks the row `expired`.
- Returns the entitlement plus `pendingCheckout.state`.

**While `pendingCheckout.state == 'processing'`** (complete but unpaid, for example async payment methods), the app polls `/billing/status` every 2 s for up to 30 s, then shows "Confirming your payment…". The paywall stays until entitlement says otherwise.

### 8.3 Portal and plan changes

**`POST /billing/portal`** (admin only)
- Calls `billingPortal.sessions.create({customer, return_url: …/return/portal})`.
- The portal configuration (created by the bootstrap script) allows: updating the payment method, viewing the invoice history, and cancelling at the end of the period with a cancellation reason.
- Plan switching is **off** in the portal. Size and interval changes go through the endpoint below, so the seat checks always run.

**`POST /billing/plan { interval, seats }`** (admin only, under the same named lock)
- `seats < memberCount` → `409 SEATS_BELOW_MEMBERS`. No change → `200`.
- **Same interval:** `subscriptions.update(sub, { items:[{ id: itemId, price: newPrice }], proration_behavior:'always_invoice', payment_behavior:'pending_if_incomplete' })`. Pending updates support changing `items[].price`.
- **Interval change:** the same call, but with `proration_behavior:'create_prorations'` and `billing_cycle_anchor:'now'`, which starts a new period that is charged immediately. Also `payment_behavior:'pending_if_incomplete'`.
- **Seats change in our records only after Stripe applies the update.** The API response, and the `customer.subscription.updated` / `pending_update_applied` events, all go through `upsertSubscription`, which stores `pending_update` when one is present. A `pending_update_expired` event notifies the admin that the change didn't go through.
- **Downgrades** (fewer seats, or yearly → monthly) also use pending updates. A downgrade creates a credit and no charge, so it applies immediately.

### 8.4 Webhook receiver and worker

**Receiver** (§4.4), which finishes within a few milliseconds:
1. Verify the signature and the mode.
2. `INSERT billing_events (provider_event_id UNIQUE, payload, status:'received')`. A duplicate → `200`.
3. Return `200`.
4. Push the row ID onto the in-process queue.

**Worker:**
- Claims a row with `UPDATE … SET status='processing', locked_at=NOW() WHERE id=? AND status IN ('received','failed')`, then dispatches it.
- Stripe API calls happen **outside** database transactions. Each database write is a short transaction of its own.
- Success → `processed`. Error → `failed`, with `attempts++` and `last_error`.
- If the object's `metadata.env` doesn't match → `ignored`.

**Sweep job** (every minute, locked):
- re-queues `received` rows, `failed` rows with `attempts < 8` (exponential backoff), and `processing` rows whose `locked_at` is more than 10 minutes old;
- moves rows with `attempts ≥ 8` to `dead` and raises a `needs_review` item.

**`upsertSubscription(subId, mode)`:**
1. Acquire the named lock `billing:sub:{subId}`, so concurrent webhook and sync calls run one after the other.
2. Fetch the subscription from Stripe, expanding `items.data.price` and `latest_invoice`. Because the fetch happens inside the lock, the last writer always writes the freshest state; timestamps are only a tiebreak (`event_watermark`).
3. Find the household: first through `billing_customers` (by customer ID and mode); then through `metadata.householdId` with `env` matching; otherwise raise an `unmatched` review item and write nothing.
4. Write: status, `items.data[0]` price / seats / `price_set` / amount / currency / period, `cancel_at_period_end`, `canceled_at`, `ended_at`, `pending_update`, and `grace_until` (§7.1). `purchased_by_user_id` is set on insert only.
5. Run the duplicate check (§8.6) and clear the entitlement cache.

**Ledger linking:**
- Invoice → its subscription (`invoice.parent.subscription_details.subscription` in the pinned API version) → `billing_subscriptions` → `household_id`, with `user_id` = the purchaser.
- If there's no subscription: `invoice.customer` → `billing_customers` → `household_id`, with `user_id` NULL.
- If neither matches: `unmatched`.
- **Fees:** invoice → `invoice.payments` (InvoicePayment) → `payment.payment_intent` → `latest_charge` → `balance_transaction` (`fee`, `net`). If the fee isn't available yet, it stays NULL and reconciliation fills it in. *The exact expand paths are verified against the pinned API version during implementation.*

### 8.5 Webhook events

| Event | Handling |
|---|---|
| `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed` | If there's a subscription → `upsertSubscription`. Mark the checkout row `complete`. |
| `checkout.session.expired` | Mark the checkout row `expired` |
| `customer.subscription.created`, `.updated`, `.deleted`, `.pending_update_applied` | `upsertSubscription` |
| `customer.subscription.pending_update_expired` | `upsertSubscription`, and notify the admin |
| `invoice.paid` | Ledger `payment` (with `billing_reason`), then `upsertSubscription` |
| `invoice.payment_failed` | Ledger `failed_payment` (one row per invoice, updated). Notify the admin **only** when `billing_reason ∈ {subscription_cycle, subscription_create}`. |
| `invoice.payment_action_required` | Notify the admin with the link to the hosted invoice page |
| `refund.created`, `refund.updated`, `refund.failed` | Ledger `refund` row per refund object, with its status kept current |
| `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated` | Ledger `dispute` row, with status, `dispute_fee` and funds state. On `created`, raise a `needs_review` item and alert staff. If closed as `lost` on an allowed subscription, set `cancel_at_period_end` and flag it. |
| `radar.early_fraud_warning.created` | Raise a `needs_review` item and alert staff |
| `customer.updated` | Keep `billing_customers.billing_email` in sync |
| anything else | `ignored` |

### 8.6 Duplicate subscriptions

After every upsert, count the subscriptions for (household, mode) whose status is `active`, `trialing` or `past_due`. If there's more than one:
1. **Keep one:** prefer `active` or `trialing` over `past_due`, then the **oldest**.
2. For each of the others: `subscriptions.cancel` (`prorate:false`), and refund the latest paid invoice's charge in full, with idempotency key `dup:{subId}`. The refund webhook records the refund in the ledger.
3. Raise a `needs_review` item, and email both staff and the household admins.

### 8.7 Household deletion
- **When deletion is scheduled or approved:** `cancel_at_period_end:true` on the household's allowed subscription. `cancelHouseholdDeletion` reverses it with `cancel_at_period_end:false`.
- **Final purge:** if the subscription is still allowed → `subscriptions.cancel` (`prorate:false`). Recorded in the audit log.
- **Afterwards:** billing lookups use `paranoid:false`, so later webhooks and admin queries still find the soft-deleted household.

### 8.8 Edge cases

**Timing**

| # | Case | Handling |
|---|---|---|
| T1 | The webhook and the app's sync race | Both go through `upsertSubscription`, which takes a per-subscription lock and fetches fresh data |
| T2 | A webhook is lost, or the server is down | Stripe keeps retrying for 3 days. The checkout sweep runs every 15 min and reconciliation runs nightly. |
| T3 | The user closes the browser, or Android reports `dismiss` | The app always syncs by `sessionId`, and the webhook or sweep catches anything left |
| T4 | Async payment or 3-D Secure | The household stays blocked until the subscription is `active`. The app shows "Confirming…". |
| T5 | Events arrive out of order | Fetch happens inside the lock. `event_watermark` breaks ties. |
| T6 | Checkout is abandoned | It expires after 31 min. The sweep marks it, and the next attempt creates a new session. |
| T7 | Server clock drift | Periods and grace use Stripe's timestamps. The `expires_at` margin is +1 minute. |
| T8 | A plan change's payment fails | `pending_if_incomplete`, so nothing changes. Expiry notifies the admin. |
| T9 | Webhooks arrive in a burst on renewal day | No rate limiter. The receiver only persists and acknowledges. |

**Double payment**

| # | Case | Handling |
|---|---|---|
| D1 | A double tap, or two admins subscribe at once | The named lock plus row reuse. Idempotency keys come from database row IDs. |
| D2 | The household is already subscribed, or its Stripe-side state is stale | Local check, then a Stripe list → `409 ALREADY_SUBSCRIBED` or `PAYMENT_ISSUE` |
| D3 | Two subscriptions get through anyway | §8.6 keeps the healthy one |
| D4 | Two customers are created at once | Unique row, plus search and idempotency key |
| D5 | The household also has an Apple or Google subscription | A review item. The admin is told how to cancel in the store. |
| D6 | Expiring a session that has already been paid | Sync it, then `409` |

**Bypass attempts**

| # | Case | Handling |
|---|---|---|
| B1 | A forged return URL | It has no side effects. `sync` checks ownership. |
| B2 | Another household's `session_id` | `403` |
| B3 | A test payment trying to unlock a live household | Modes must match. Separate sandboxes and the `env` tag. |
| B4 | A price or quantity sent by the app | Ignored. The server picks the price from the catalog. |
| B5 | A forged or replayed webhook | Signature check, 300 s tolerance, unique event ID, mode check |
| B6 | A non-admin tries to buy or change the plan | `403` |
| B7 | A modified app | Guarded routers return 402, sockets are gated, jobs are filtered, and the ICS feed is empty |
| B8 | Cohort self-service | Only staff with the billing key can change it, and every change is audited |
| B9 | Promo codes | Off |
| B10 | Content leaking through side channels | Notification history is guarded, the ICS feed is empty, and `/uploads` is disabled in production |

**Lifecycle**

| # | Case | Handling |
|---|---|---|
| L1 | A renewal payment fails | Smart Retries → `past_due` → 7-day grace → blocked. **Dashboard setting: once all retries fail, cancel the subscription.** The data is kept, and the admin can subscribe again. |
| L2 | Cancellation | `cancel_at_period_end`, so access continues until `current_period_end` |
| L3 | A refund | Recorded in the ledger. A full refund **doesn't** cancel automatically; staff cancel it themselves if they intend to. |
| L4 | A dispute | Flagged. If lost, `cancel_at_period_end`. |
| L5 | Fewer seats than current members | `409` |
| L6 | The purchaser deletes their account | §5.11: `cancel_at_period_end`, notify the admins, update the billing email |
| L7 | The household is deleted | §8.7 |
| L8 | The admin role is transferred | The billing email follows (§5.11), and any admin can manage billing |
| L9 | A cohort change | §11: refused while there's an allowed subscription or an open session in the current mode, unless `force` is passed. `force` sets `cancel_at_period_end` and expires open sessions. |

---

## 9. Receipts, notifications and compliance

- **Emails:** set in the Stripe Dashboard for each environment and listed in the runbook. Successful-payment receipts on; refund emails on; **upcoming-renewal reminders on** (7 days before each yearly renewal); failed-payment emails on, with a link to the hosted invoice.
- **In-app and Resend notices:** payment failed (cycle invoices only), grace ending in 2 days, subscription cancelled or ended, price-change notices, purchaser deletion.
- **At purchase:** the auto-renewal disclosure appears both in the app and on the Checkout submit button, with terms-of-service consent required. Cancellation is reachable in two taps (More → Subscription → Manage).

---

## 10. Reconciliation

Stripe is the source of truth. Every billing job takes a named lock (`billing:job:{name}:{mode}`), so running several instances is safe.

| Job | Schedule | Work |
|---|---|---|
| Event sweep | Every minute | §8.4 |
| Checkout sweep | Every 15 min | Sessions `open` for more than 5 min, or stuck in `creating` for more than 5 min: fetch them; `complete` → sync; `expired` → mark it; a `creating` session with no Stripe ID → `failed` |
| Daily | 03:30 UTC per mode | (a) Re-fetch every local subscription in `active`, `trialing` or `past_due`. (b) `subscriptions.list({status:'all', created ≥ now−48h})`, plus every subscription named in the last 48 h of ledger rows. (c) `invoices.list`, `refunds.list` and `disputes.list` with `created ≥ now−48h` → ledger upserts. (d) Fill missing fees. (e) Customer email drift (§5.11). |
| Weekly | Sunday 04:00 UTC | Paginate **every** subscription per mode (`status:'all'`). Invoices, refunds and disputes for the last 35 days. These list APIs aren't limited to 30 days the way the Events API is. |
| Price notices | Daily | §6.4 |
| Manual | `POST /billing-admin/reconciliation/run` | On demand |

Every object is filtered by `metadata.env`.

**Fixed automatically:**
- differences in status, period, seats, price or amount, `cancel_at_period_end`, `pending_update` or grace;
- a missing ledger row, fee or refund/dispute status;
- stale checkout rows;
- billing email drift.

**Raised for review:**
- an unmatched customer, invoice or subscription;
- more than one allowed subscription that §8.6 didn't resolve;
- a local subscription that is missing in Stripe (marked `canceled` *and* flagged);
- an amount that still differs after a fix;
- dead events.

**Alerting:**
- New review items → one summary email per run to `ADMIN_EMAIL`.
- Five or more `failed` events in 15 minutes, or any `dead` event → an immediate alert email.
- A reconciliation run that fails or takes more than 30 minutes → an alert email.

---

## 11. Staff billing API

- **Mount and auth:** `/api/v1/billing-admin`, a separate router at a separate path, so the existing `ADMIN_API_KEY` middleware never applies to it. Header `x-admin-billing-key`, compared with `crypto.timingSafeEqual`, plus the optional IP allowlist.
- **Audit:** every request is logged in `admin_audit_log`.
- **Conventions:** cursor pagination (`?cursor&limit ≤ 200`), responses shaped `{ success, data, nextCursor }`, and `@openapi` docs on every route.
- **Key-separation test:** each key returns 401 on the other surface.

| Route | Purpose |
|---|---|
| `GET /transactions` | Filters: `mode` (default `live`), `householdId`, `userId`, `email`, `type`, `status`, `matchStatus`, `billingReason`, `from`, `to`. Rows include the household name, payer email, amounts, fee and net, and a Stripe Dashboard link. |
| `GET /transactions/:id` | One transaction, with its subscription and household |
| `GET /transactions.csv` | Same filters, streamed |
| `GET /summary?mode&from&to` | gross (paid payments) − refunds (succeeded) − dispute amounts (funds withdrawn and not reinstated) − fees − dispute fees = net. MRR is monthly plans plus yearly plans ÷ 12 for allowed subscriptions. Also counts of active, past-due and in-grace subscriptions, and failed cycle payments. |
| `GET /households/:id` | Cohort, entitlement, subscriptions (every mode, labelled), customers, members, recent transactions |
| `GET /subscriptions?mode&status` | List |
| `GET /reconciliation/runs`, `GET /reconciliation/items?status=` | Review |
| `POST /reconciliation/run`, `POST /reconciliation/items/:id/resolve {resolution, note}` | Act |
| `POST /households/:id/cohort {cohort, reason, force?}` | Change a household's cohort (L9). Clears the cache, audited. |
| `GET /routing`, `PUT /routing {rules}` | Routing rules, replaced in a single transaction and audited |
| `POST /events/:id/replay` | Re-queue an event from `billing_events` |

---

## 12. Routing rules

- **What the app sends:** `X-Platform` (`ios`, `android` or `web`) and `X-Store-Country`:
  - **iOS:** the App Store storefront country (from the IAP module, Phase 2).
  - **Android:** the Play billing country (from the IAP module, Phase 3).
  - **Web, and dev builds before Phases 2–3:** `ZZ`, which matches only `*` rules.
- **Resolution:** exact `(platform, country)` → `(platform, '*')` → `none`.
- **Test cohort and dev:** `stripe_checkout` is always allowed, so testing works everywhere.
- **Effect:** `purchaseMethod` in `/billing/status` decides which flow the app starts. A method the app doesn't support shows "Purchasing isn't available here yet". The server refuses checkout when the routed method is something else (§8.1 step 2).
- **Integrity:** the country header can be faked. That's acceptable, because a faked country only changes *which* payment method is offered, never whether payment is needed. App Store and Play policy is enforced by each store's own purchase sheet for IAP, and Stripe is offered only where the rules allow it.

---

## 13. Testing

1. **Unit tests** (Jest, Stripe mocked), target **≥ 90% coverage of `modules/billing`**:
   - `resolveMode` and the startup checks;
   - every combination of entitlement × cohort × status × grace × mode;
   - grace computation from invoice timestamps;
   - catalog lookup, the price-set formulas (verify all 12 amounts), and cache busting;
   - routing resolution;
   - seat checks;
   - ledger linking and sign arithmetic;
   - reconciliation classification;
   - duplicate selection (active beats past_due, then oldest);
   - the `env` tag filter;
   - webhook secret rotation (two secrets).
2. **Integration tests** (supertest, real MySQL `rootaroo_test`, signed payloads from `generateTestHeaderString`):
   - a bad signature → 400, a mode mismatch → 400, and a duplicate event is processed once;
   - a crash in `processing` gets swept;
   - `updated` arriving before `created`, and a concurrent webhook and sync → correct final state;
   - two concurrent `/checkout` calls → one session;
   - a second checkout while `past_due` → `PAYMENT_ISSUE`;
   - checkout with seats below the member count → 409;
   - duplicate subscriptions → the healthy one is kept;
   - a foreign `sync` → 403; a non-admin → 403; a price or quantity from the app is ignored;
   - every guarded route returns 402 while unguarded routes work, and no household → 403;
   - the ICS feed is empty while blocked, and blocked socket events are dropped;
   - concurrent joins at the seat limit → exactly one succeeds;
   - billing-admin and admin each reject the other's key;
   - the webhook route isn't rate limited;
   - purchaser deletion → `cancel_at_period_end` and ledger anonymisation;
   - household deletion scheduling and cancelling it.
3. **End to end** in the dev sandbox (real Stripe API, `stripe listen --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test`, Checkout completed in Chrome):
   - **Successful purchases:** 5-member monthly and 7-member yearly with `4242…`.
   - **Card outcomes:** 3-D Secure (`4000 0025 0000 3155`); declined (`4000 0000 0000 9995`).
   - **Test clock:** renewal → payment failure (`4000 0000 0000 0341`) → grace → blocked → card updated in the portal → restored.
   - **Plan changes:** add seats, interval switch, downgrade, and a failed upgrade that leaves a pending update which then expires.
   - **Cancellation:** cancel in the portal.
   - **Refunds and disputes:** a partial and a full refund; a dispute (`4000 0000 0000 0259`), won and lost.
   - **Missed webhooks:** stop the listener, then confirm the sweep and reconciliation recover.
   - **Planted drift:** corrupt local rows, then reconcile.
   - **Cohorts:** the test-cohort bypass, and a test subscription failing to unlock a live household.
   - **Staff API:** ledger links, CSV, summary arithmetic, the review queue, cohort and routing changes, event replay.
4. **Mobile:** checkout → return → paywall → subscription screen on the Android emulator (dev client). A manual checklist for iOS on a real device.
5. **Release gate** (all phases): the Phase 2 and Phase 3 device checklists pass. These cover Apple sandbox / StoreKit configuration, Play license testers and the internal testing track, and cross-provider duplicate checks.

---

## 14. Restricted key permissions

- **Runtime key (per environment):**
  - **Write:** Customers, Checkout Sessions, Subscriptions, Billing Portal sessions, Refunds.
  - **Read:** Customers (including search), Prices, Products, Invoices, Invoice Payments, PaymentIntents, Charges, Balance transactions, Disputes, Events, Early fraud warnings, Refunds.
- **Bootstrap key** (staff only, run once per environment): write Products, Prices, Webhook endpoints and Portal configurations.

---

## 15. Before launch (release-gate checklist)

- [ ] **Universal links:** `apple-app-site-association` and `assetlinks.json` on rootaroo.com, with return URLs moved to them.
- [ ] **Tax:** choose between Stripe Tax (with state registrations) and Managed Payments. Until then, `automatic_tax` stays off.
- [ ] **App Review:** check the current Guideline 3.1.1(a) for the US link-out, and put the routing rules in the review notes.
- [ ] **Google Play:** complete the alternative billing / external offers declarations for the US.
- [ ] **Dashboard settings for each environment:** receipts, renewal reminders, Smart Retries, "cancel after all retries", public details including the Terms URL, and portal configuration (set by the bootstrap script).
- [ ] **Keys:** restricted keys created, the design-time `sk_test` rolled, and the webhook-secret rotation tested.
- [ ] **Runbooks:** key rotation, webhook secret rotation, handling review items, refunds, disputes, cohort changes and price changes.

---

## 16. Phases 2–3 (Apple IAP, Google Play): contracts

- **Products:** 12 auto-renewable subscriptions per store, `rootaroo.hh{5..10}.{month|year}`, priced as close to §6.1 as each store's price points allow.
  - **Apple:** one subscription group, ranked by size, so moving up or down a size is an upgrade or downgrade inside the group.
  - **Google:** one subscription per size, with monthly and yearly base plans.
- **Server:** the same tables, with `provider = 'apple' | 'google'`.
  - **Apple:** App Store Server API plus App Store Server Notifications V2. The `sandbox` environment maps to `livemode=false`.
  - **Google:** Play Developer API plus Real-time Developer Notifications (Pub/Sub push). License-tester purchases map to `livemode=false`.
  - **Linking a purchase to a household:** `appAccountToken` (Apple) or `obfuscatedAccountId` (Google) is set to the household ID. The server verifies every purchase before any entitlement is granted.
- **Shared rules:** entitlement, grace, one allowed subscription per household, duplicate detection (store subscriptions can't be cancelled by us, so a duplicate becomes a review item), the ledger, reconciliation (through the store APIs) and the staff API all work across providers.
- **Ownership:** a store subscription belongs to the buyer's Apple or Google account. If that admin leaves or deletes their account, the household gets a 7-day grace period to resubscribe, and the leave flow warns them first.
- **App:** a native IAP module (e.g. `expo-iap`, checked against Expo SDK 54) and a new EAS build. Restore purchases, and the storefront country feeds routing (§12).
- **Plan changes:** IAP users change size or interval through the store's own subscription UI. The server reflects whatever the store's notifications report.
