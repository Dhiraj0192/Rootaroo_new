# Rootaroo Billing: Stripe + In-App Purchase. Design Spec

- **Status:** Draft for review
- **Date:** 2026-10-02
- **Branch:** `feat/billing`
- **Scope:** Phase 0 (deep-link scheme rename) and Phase 1 (Stripe), specified in full. Phase 2 (Apple IAP) and Phase 3 (Google Play Billing) are specified at the level of the data model and contracts, so Phase 1 doesn't need reworking for them. Each phase gets its own implementation plan.

---

## 1. Goal and success criteria

Household admins pay for Rootaroo. The server enforces a hard paywall. Test and live billing are fully separate. Rootaroo staff can see every transaction, and which user and household it belongs to, through an admin API without opening the Stripe Dashboard.

Phase 1 is done when all of these hold:

1. An admin on a live-cohort household can subscribe through Stripe Checkout (test mode during development), return to the app, and be unlocked. The subscription is driven only by verified Stripe data.
2. A non-entitled household gets `402` on every feature route, and the app shows the paywall.
3. Renewal, failed payment → grace → block, cancellation, member-count changes, refunds and disputes all behave as in §8, proven end to end with Stripe test mode and test clocks (§12).
4. Every money movement appears in `billing_transactions`, linked to a household and user, and can be queried through the admin API.
5. Reconciliation finds mismatches that were planted deliberately and fixes them, or flags them for review.
6. Test and live share no keys, secrets, prices, or rows. A test payment can never unlock a live household.

### Decisions already made

| Topic | Decision |
|---|---|
| Rates (official) | USD. **$8.99/month** or **$79.99/year**, covering **5 members**. **$1.99/month per extra member** ($23.88/year on yearly plans). **Maximum 10 members.** No trial. |
| Payment UI | Stripe-hosted Checkout + Customer Portal, opened with `expo-web-browser` `openAuthSessionAsync` (approach A). |
| Platforms | Stripe Checkout is the default everywhere. Apple IAP (Phase 2) and Google Play Billing (Phase 3) are built afterwards. Which one a user sees is chosen by **server-side routing rules per platform and country**, which staff can change without an app release. |
| Paywall | Hard paywall. 7-day grace period after a failed renewal. Data is never deleted because of non-payment. |
| Existing and test users | Cohort flag per household: `live` (default) or `test`. A test-cohort household skips the paywall and uses Stripe **test** mode, even on production. Only staff can change the cohort, through the admin API. |
| Price changes | New prices take over by moving the lookup key to them. Existing subscribers **keep their old price by default**. Moving them to a new price is a deliberate staff action, with at least 30 days' notice, taking effect at renewal. |
| Admin | API only for now, documented in OpenAPI. A separate admin app is a later sub-project. |
| Deep-link scheme | Rename `rootaru` → `rootaroo` everywhere, keeping **no** support for the old spelling (we're not live). |

---

## 2. Phase 0: Deep-link scheme rename (Task 0)

One commit, which can be reverted on its own. It ships in the same native build as Phase 1, because the billing return link needs the scheme compiled into the app.

| Location | Change |
|---|---|
| `mobile/app.json` `"scheme"` | `"rootaru"` → `"rootaroo"` |
| `mobile/src/screens/HouseholdSetupScreen.jsx` (`JOIN_LINK_RE` + comment) | `rootaroo://join?code=` |
| `mobile/src/screens/HouseholdSettingsScreen.jsx:81`, `InviteMembersScreen.jsx:41` | `rootaroo://join?code=` |
| `server/src/modules/household/service.ts:149` (`shareLink`) + its test | `rootaroo://join?code=` |
| Storage keys in `authPersist.js`, `signupProgress.js`, `dailyWelcomePersist.js` | `rootaroo_*`. Side effect: dev testers are signed out once. |
| `calendar/service.ts:374` UID `@rootaru` | `@rootaroo`. Side effect: calendars synced during development show each event twice once. Acceptable before launch. |
| `calendar/controller.ts:62` filename, `server/restart-dev.sh`, `docs/auth-documentation.html` | Rename |

Done when `git grep -nE "rootaru([^o]|$)"` returns nothing. Requires a new EAS dev-client build.

---

## 3. Architecture overview

```
Mobile app                        API server (Express)                         Stripe (test | live)
──────────                        ────────────────────                         ────────────────────
Paywall / Subscription screen ──► POST /billing/checkout ─────────────────────► Checkout Session
openAuthSessionAsync(url) ───────────────────────────────────────────────────► Hosted Checkout
                                  GET /billing/return/:result  ◄──redirect──── (success / cancel)
rootaroo://billing/<result> ◄──── 302 + HTML fallback
POST /billing/checkout/:id/sync ► retrieve session → upsertFromStripe()
                                  POST /billing/webhooks/stripe/{test|live} ◄── signed events
                                        → billing_events (dedupe) → upsertFromStripe() / ledger
GET /billing/status ────────────► getEntitlement()  (Redis 60 s cache)
Every feature route ────────────► requireEntitlement → 402 SUBSCRIPTION_REQUIRED
                                  Jobs: checkout sweep · failed-event retry · reconciliation
Staff (API key) ────────────────► /admin/billing/*  (ledger, summary, review queue, routing, cohort)
```

New server module `server/src/modules/billing/`:

| File | Responsibility |
|---|---|
| `config.ts` | Loads keys per mode, checks them at startup (§4), and creates one `Stripe` client per mode, with API version pinned to `2026-09-30.endive` and SDK `stripe@22.x`. |
| `mode.ts` | `resolveMode(household)` → `'test' \| 'live'` |
| `catalog.ts` | Prices by lookup key, cached in memory for 10 min per mode; `GET /billing/plans` |
| `entitlement.ts` | `getEntitlement()`, the `requireEntitlement` middleware, member-limit checks, Redis cache |
| `checkout.ts` | Creating checkout sessions, sync, the portal, member-count changes |
| `sync.ts` | `upsertSubscriptionFromStripe()`, the **only** code that writes subscription state |
| `ledger.ts` | Writing transactions and linking them to households and users |
| `webhooks.ts` | Raw-body route, signature and mode checks, dedupe, dispatch |
| `reconcile.ts` | Reconciliation runs and their items |
| `routing.ts` | Routing rules per platform and country |
| `admin.controller.ts` / `admin.routes.ts` | The staff API, mounted under `/api/v1/admin/billing` |
| `jobs/billing-*.ts` | Checkout sweep, event retry, daily and weekly reconciliation |
| `scripts/stripe-bootstrap.ts` | Creates the product catalog, portal settings and webhook endpoints, safely re-runnable; also `--set-price`, `--backfill`, `--migrate-price` |

---

## 4. Test/live separation

### 4.1 Environment variables (server)

```
STRIPE_TEST_SECRET_KEY        sk_test_… or rk_test_…
STRIPE_TEST_WEBHOOK_SECRET    whsec_…
STRIPE_LIVE_SECRET_KEY        sk_live_… or rk_live_…   (production only)
STRIPE_LIVE_WEBHOOK_SECRET    whsec_…                  (production only)
BILLING_PUBLIC_BASE_URL       https origin used in Checkout success/cancel/return URLs
ADMIN_BILLING_API_KEY         separate staff key for /admin/billing/*
BILLING_GRACE_DAYS=7
```

There are no price IDs in the environment (§6). The mobile app gets **no Stripe keys at all**, because Checkout is hosted by Stripe and the publishable key isn't needed.

### 4.2 Startup checks (fatal unless stated)

- A key in `STRIPE_TEST_*` doesn't start with `sk_test_` or `rk_test_` → refuse to start.
- A key in `STRIPE_LIVE_*` doesn't start with `sk_live_` or `rk_live_` → refuse to start.
- `NODE_ENV !== 'production'` and any `STRIPE_LIVE_*` is set → refuse to start. Dev and staging can never charge real cards.
- `NODE_ENV === 'production'` and the live key or live webhook secret is missing → refuse to start.
- A test key is missing → test mode is disabled. Test-cohort households still skip the paywall, but their checkout returns `503 BILLING_MODE_UNAVAILABLE`. Logged as a warning.
- Keys are never logged. The logger redacts anything matching `/(sk|rk)_(test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/`.

### 4.3 Choosing the mode

```
resolveMode(household):
  if NODE_ENV !== 'production'      → 'test'
  if household.billing_cohort=='test' → 'test'
  else                               → 'live'
```

Every Stripe call, database read and webhook check takes `mode` as a parameter. Every billing row stores `livemode`. Entitlement only counts rows where `livemode` matches `resolveMode(household)`.

### 4.4 Webhook endpoints

`POST /api/v1/billing/webhooks/stripe/test` and `/live`. Each verifies the signature against **its own** secret (`constructEvent`, 300 s tolerance) and rejects any event where `event.livemode` doesn't match the endpoint (`400`). The bootstrap script registers both endpoints in Stripe, each with only the events listed in §8.2.

### 4.5 Protecting secrets in the repo

- Real values exist only in the gitignored `server/.env` locally, and in Railway's environment variables in production.
- A Husky pre-commit hook blocks any staged file matching `/(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/`.
- `.env.example` gets the new variable names with empty values.
- Before going live: create **restricted keys** (`rk_`) with only the permissions needed (§13) for each mode, and **roll** the `sk_test` key that was pasted into the chat during design.

---

## 5. Data model

All new tables are created by Sequelize migrations in `server/src/database/migrations/2026100x-*`. UUID primary keys, `created_at`/`updated_at`, and **`paranoid: false`** (billing rows are never soft-deleted).

### 5.1 `households` (new column)
- `billing_cohort ENUM('live','test') NOT NULL DEFAULT 'live'`

### 5.2 `billing_customers`
`id, household_id FK, provider ENUM('stripe','apple','google'), livemode BOOL, provider_customer_id VARCHAR(255)`
- UNIQUE `(household_id, provider, livemode)`; UNIQUE `(provider, livemode, provider_customer_id)`

### 5.3 `billing_subscriptions`
`id, household_id FK, provider, livemode, provider_subscription_id VARCHAR(255),
status ENUM('incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused'),
interval ENUM('month','year'), seats_included TINYINT DEFAULT 5, seats_extra TINYINT DEFAULT 0,
base_price_id, base_unit_amount INT, extra_price_id NULL, extra_unit_amount INT NULL, currency CHAR(3),
current_period_start DATETIME, current_period_end DATETIME, cancel_at_period_end BOOL, canceled_at NULL,
first_failed_at NULL, grace_until NULL, purchased_by_user_id NULL FK users (SET NULL),
provider_updated_at DATETIME, last_synced_at DATETIME`
- UNIQUE `(provider, livemode, provider_subscription_id)`
- INDEX `(household_id, livemode, status)`
- Amounts are integers in the smallest currency unit (cents).

### 5.4 `billing_checkout_sessions`
`id, household_id, livemode, provider_session_id UNIQUE, created_by_user_id, interval, seats_extra,
status ENUM('open','complete','expired'), url TEXT, expires_at, return_scheme`
- Used to give a repeat request the same session, and by the checkout sweep. At most one `open` row per `(household_id, livemode)`, enforced by the lock in §8.1.

### 5.5 `billing_events`
`id, provider, livemode, provider_event_id UNIQUE, type, status ENUM('processing','processed','failed','ignored'),
attempts INT, last_error TEXT NULL, received_at, processed_at`

### 5.6 `billing_transactions` (ledger)
`id, provider, livemode, type ENUM('payment','failed_payment','refund','dispute'),
status VARCHAR(32), amount INT, fee INT NULL, net INT NULL, currency CHAR(3),
household_id NULL, user_id NULL, subscription_id NULL, match_status ENUM('matched','unmatched'),
household_name_snapshot, payer_email_snapshot,
provider_invoice_id NULL, provider_charge_id NULL, provider_refund_id NULL, provider_dispute_id NULL,
provider_object_id VARCHAR(255) NOT NULL, receipt_url NULL, description, occurred_at, raw_event_id NULL`
- UNIQUE `(provider, livemode, type, provider_object_id)`. The ledger's identity is the **Stripe object**, not the event, so a webhook and a reconciliation backfill can't create two rows. `provider_object_id` is the invoice ID for `payment` and `failed_payment` (one failed row per invoice, updated on each retry), the refund ID for `refund`, and the dispute ID for `dispute`.
- INDEX `(livemode, occurred_at)`, `(household_id, occurred_at)`, `(user_id)`.
- Refunds and disputes are stored as **positive** amounts, with the direction given by `type`. Summaries do the arithmetic.

### 5.7 `billing_routing_rules`
`id, platform ENUM('ios','android','web'), country CHAR(2) or '*', method ENUM('stripe_checkout','apple_iap','google_play','none'),
updated_by VARCHAR(100), updated_at`
- UNIQUE `(platform, country)`. Seeded with `(*, '*') → stripe_checkout` for all three platforms.

### 5.8 `billing_price_notices`
`id, subscription_id, from_price_id, to_price_id, notice_sent_at, effective_at, applied_at NULL, status`

### 5.9 `billing_reconciliation_runs` / `billing_reconciliation_items`
- Runs: `id, livemode, kind ENUM('daily','weekly','manual'), started_at, finished_at, status, counts JSON`
- Items: `id, run_id, livemode, kind, entity_type, entity_id, provider_object_id, before JSON, after JSON,
resolution ENUM('auto_fixed','needs_review','resolved','ignored'), resolved_by, resolution_note, resolved_at`

### 5.10 `admin_audit_log`
`id, actor (key label), method, path, query JSON, body_digest, status_code, ip, created_at`. Every `/admin/*` request.

### 5.11 Privacy
When a user's account is permanently deleted (after the existing 30-day purge), the ledger's `user_id` is set to NULL and `payer_email_snapshot` to `'deleted user'`. Transactions are kept for 7 years for tax purposes. This matches the draft Privacy Policy, §9.

---

## 6. Catalog and price changes

### 6.1 Products and prices (identical in test and live; created by `stripe-bootstrap.ts`)

| Product | Lookup key | Amount | Interval |
|---|---|---|---|
| Rootaroo Household (5 members) | `rootaroo_household_month` | 899 USD | month |
| | `rootaroo_household_year` | 7999 USD | year |
| Rootaroo Extra Member | `rootaroo_extra_member_month` | 199 USD | month |
| | `rootaroo_extra_member_year` | 2388 USD | year |

Prices are `tax_behavior: 'exclusive'`, ready for Stripe Tax later (§14).

### 6.2 `GET /api/v1/billing/plans`
Returns, for the household's mode: `{ currency, seatsIncluded: 5, seatsMax: 10, intervals: { month: { base, extraMember }, year: { base, extraMember } } }`. Amounts are in cents, from the cached prices (10 min). The app calculates every displayed price and "savings" figure from this. **The `PRICE` constant is removed from `featureTourContent.js`.** The "~$399 elsewhere" comparison stays as marketing copy.

### 6.3 Changing a price
`stripe-bootstrap.ts --mode test|live --set-price <lookup_key> --amount <cents>` creates a new price with `transfer_lookup_key: true`, then clears the catalog cache through a Redis pub/sub message. `--mode live` additionally requires `--confirm-live`. New checkouts pick up the new price within 10 minutes, or straight away once the cache is cleared.

### 6.4 Existing subscribers
- **Default:** they keep their price, recorded on the subscription row.
- **Moving them:** `--migrate-price <lookup_key> --notice-days 30`:
  1. Inserts `billing_price_notices` rows and sends an email (Resend) and an in-app notification to each household admin.
  2. A daily job applies each due notice at the subscriber's next renewal: `subscriptions.update` with the new price, `proration_behavior: 'none'` and `billing_cycle_anchor: 'unchanged'`, then marks the notice applied.
  3. A household that cancels during the notice period is skipped.

---

## 7. Entitlement and paywall

### 7.1 `getEntitlement(householdId)` → `{ allowed, reason, mode, subscription?, graceUntil?, seatsAllowed }`

1. `billing_cohort == 'test'` → `allowed`, reason `test_cohort`, `seatsAllowed = 10`.
2. Find the household's subscription where `livemode` matches the mode and `status ∈ {active, trialing, past_due}`, newest `current_period_end` first.
   - `active` or `trialing` → `allowed`.
   - `past_due` and `now < grace_until` → `allowed`, reason `grace`. The app shows a banner.
   - Anything else, or none → `allowed:false`, reason `subscription_required`, `seatsAllowed = 5`, so join and invite still work before subscribing.
3. `seatsAllowed = seats_included + seats_extra` for the active subscription.

`grace_until = first_failed_at + BILLING_GRACE_DAYS`. `first_failed_at` is set on the first `invoice.payment_failed` of a billing period and cleared on `invoice.paid`. If Stripe moves the subscription to `unpaid` or `canceled`, access is blocked immediately, even during grace.

**Cache:** the result is kept in Redis under `billing:ent:{householdId}` for 60 s. It's cleared on every subscription write and every cohort change. If Redis is unavailable, the database is read directly.

### 7.2 Server enforcement
The `requireEntitlement` middleware is added to these routers: `feed, tasks, groceries, todos, expenses, vault, events, chat, checkins, pings, places, journal, dashboard, weather`.
- A blocked request gets `402 { success:false, code:'SUBSCRIPTION_REQUIRED', isAdmin, reason }`.
- **Not blocked:** `auth/*` (including account deletion), `households/*` (setup, join, leave, settings, invites, subject to the member limit), `billing/*`, `notifications/tokens`, `notifications/preferences`, `admin/*`, `calendar-feed` (the ICS token feed, read-only).
- **Socket.IO:** `chat:typing` and `presence:online` are ignored for blocked households, checked on connect and cached.

### 7.3 Member limit
`household/service.join` and invitation acceptance check `memberCount < seatsAllowed`, otherwise `402 SEAT_LIMIT`. This runs inside the same transaction as the insert, with `SELECT … FOR UPDATE` on the household row, so two simultaneous joins can't both get through.

### 7.4 In the app
- `GET /billing/status` is called on launch, when the app returns to the foreground, after returning from checkout or the portal, and after any 402. It returns `{ entitlement, subscription, isAdmin, adminName, purchaseMethod, plans }`.
- A new Zustand `billingStore` holds it. An axios response interceptor sends any `402` to `billingStore.refresh()`.
- `RootNavigator`: signed in, in a household, not allowed → a `PaywallStack`, which replaces `MainTabs`:
  - **Admin:** `PaywallScreen` (interval toggle, household size 5–10, the total worked out from `plans`, Subscribe, Restore, links to the Terms and Privacy Policy).
  - **Member:** `PaywallMemberScreen` ("Ask {adminName} to renew"), with a retry button.
- Grace: a banner in `MainTabs` with a "Fix payment" button that opens the portal.
- **Onboarding:** `FeaturePricingScreen`'s CTA starts checkout. `finish()` only runs after entitlement is confirmed, or when the user chooses "Not now", in which case the paywall appears.
- **More → Household → Subscription** (`SubscriptionScreen`): current plan, renewal date, price actually paid, members used and allowed, and buttons for **Manage subscription** (portal), **Change members**, and **Restore purchases** (which re-syncs).

---

## 8. Purchase flow, webhooks and edge cases

### 8.1 Checkout: `POST /api/v1/billing/checkout`
Body: `{ interval: 'month'|'year', householdSize: 5..10, returnScheme: 'rootaroo' }`, checked with Zod. `returnScheme` must be exactly `rootaroo`.

1. Authenticated user who is an **admin of their household**, otherwise `403`.
2. `mode = resolveMode(household)`. That mode is unavailable → `503`.
3. **Lock:** `SELECT … FOR UPDATE` on the household row, inside a database transaction, so concurrent requests run one at a time.
4. The household already has an allowed subscription (active, trialing, or past_due in grace) in this mode → `409 ALREADY_SUBSCRIBED`.
5. An `open` session exists for (household, mode), hasn't expired, and has the same interval and size → **return its URL**. If the parameters differ, expire it in Stripe first (`checkout.sessions.expire`), then continue.
6. Find or create the `billing_customers` row. Creating the Stripe customer uses idempotency key `cust:{householdId}:{mode}`, metadata `{householdId}`, and the admin's email. A unique-key conflict → read the existing row again.
7. Look up the prices by key. `seats_extra = householdSize - 5`.
8. `checkout.sessions.create` with:
   - `mode:'subscription'`, `customer`, `client_reference_id: householdId`
   - `line_items`: base ×1, plus extra member ×`seats_extra` if more than 0
   - `subscription_data.metadata: { householdId, purchasedByUserId }`
   - `origin_context:'mobile_app'`, `expires_at: now + 30 min`, `allow_promotion_codes: false`
   - `success_url: {BILLING_PUBLIC_BASE_URL}/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}`
   - `cancel_url: …/return/cancel`
   - `integration_identifier: 'rootaroo_app_<8 random letters>'`
   - **no** `payment_method_types`
   - idempotency key `co:{householdId}:{mode}:{interval}:{size}:{5-minute bucket}`
9. Insert the `billing_checkout_sessions` row (`open`), commit, return `{ url, sessionId }`.

### 8.2 Returning to the app
- `GET /api/v1/billing/return/:result` (`success` or `cancel`) is public, has **no side effects**, and grants nothing. It answers with a `302` to `rootaroo://billing/<result>?session_id=…`, plus an HTML fallback page with an "Open Rootaroo" button. Universal links on `rootaroo.com` come before launch (§14).
- The app opens checkout with `WebBrowser.openAuthSessionAsync(url, 'rootaroo://billing')`, then calls `POST /billing/checkout/:sessionId/sync`.
- **`sync`:** fetches the session from Stripe in the household's mode, expanding `subscription`. It checks `session.client_reference_id == caller's householdId`, that `session.customer` is that household's customer for this mode, and that the caller is a member. If any check fails → `403`. If `status == 'complete'` and there's a subscription → `upsertSubscriptionFromStripe(subId)`. Returns the entitlement.
- The app polls `/billing/status` every 2 s for up to 30 s while `payment_status != 'paid'`, then shows "Confirming your payment. This can take a few minutes." The paywall stays until entitlement says otherwise.
- Cancelling or dismissing the browser → back to the paywall, with nothing changed.

### 8.3 Portal and member-count changes
- `POST /billing/portal` (admin only) → `billingPortal.sessions.create({ customer, return_url: …/return/portal })`. The portal configuration from the bootstrap script allows updating the payment method, viewing invoices, cancelling at the end of the period, and switching between the monthly and yearly base prices. It does **not** allow editing quantities; member counts change only through the endpoint below.
- `POST /billing/seats { householdSize }` (admin only, same lock):
  - Refuses `householdSize < current member count` → `409 SEATS_BELOW_MEMBERS` with that count.
  - Otherwise `subscriptions.update`, adding, changing or removing the extra-member item, with `proration_behavior:'always_invoice'` and `payment_behavior:'pending_if_incomplete'`. **The member count stored on our side only changes when the webhook or sync reports the update as applied.** If payment fails, Stripe drops the pending update and nothing changes.

### 8.4 Webhooks
**Pipeline:**
1. The raw body route is mounted in `app.ts` **before** `express.json()`.
2. Verify the signature, then check `livemode`.
3. `INSERT billing_events (provider_event_id UNIQUE)`. A duplicate whose existing row is `processed` or `ignored` → `200`. A duplicate whose row is `processing` and less than 5 minutes old → `200`, since the other attempt will finish. A `failed` row → process it again.
4. Process it inside a database transaction.
5. Mark it `processed` → `200`. On an exception: mark it `failed`, store the error, and return `500` so Stripe retries.

**Events and what they do:**

| Event | Handling |
|---|---|
| `checkout.session.completed` | If `mode=subscription` and there's a subscription → `upsertSubscriptionFromStripe`. Mark the checkout row `complete`. |
| `checkout.session.async_payment_succeeded` / `_failed` | `upsertSubscriptionFromStripe` (the subscription status is the truth) |
| `checkout.session.expired` | Mark the checkout row `expired` |
| `customer.subscription.created/updated/deleted` | `upsertSubscriptionFromStripe(id)`, then the duplicate check (§8.6) |
| `invoice.paid` | Ledger `payment`. Clear `first_failed_at` and `grace_until`. Upsert the subscription. |
| `invoice.payment_failed` | Ledger `failed_payment`. Set `first_failed_at` if empty, and `grace_until`. Notify the admin. |
| `invoice.payment_action_required` | Notify the admin with a link to the hosted invoice page |
| `charge.refunded` | Ledger `refund` row for each refund object. Access follows the subscription status. |
| `charge.dispute.created` / `.closed` | Ledger `dispute`. Add a `needs_review` item and alert staff by email. A lost dispute on an active subscription → cancel at period end and flag. |
| `radar.early_fraud_warning.created` | Add a `needs_review` item and alert staff |
| anything else | Mark `ignored` |

**`upsertSubscriptionFromStripe(subId, mode)`** fetches the subscription from Stripe (expanding `items.data.price` and `latest_invoice`) and resolves the household: first through `billing_customers` (customer ID → household), then through `metadata.householdId` as a fallback. If neither works, it stores nothing for entitlement and adds an `unmatched` review item.
- If the stored `provider_updated_at` is newer than what Stripe returned, it does nothing. This makes out-of-order events harmless.
- It saves the status, period, items (base and extra), amounts, `cancel_at_period_end`, and `canceled_at`, then clears the entitlement cache.
- `purchased_by_user_id` comes from `metadata.purchasedByUserId` and is only written on insert.

**Linking a ledger row:** invoice → `invoice.parent.subscription_details.subscription` (for the pinned API version) → `billing_subscriptions` gives the household and `purchased_by_user_id` as `user_id`. Otherwise: `invoice.customer` → `billing_customers` gives the household, with `user_id` NULL. Otherwise: `unmatched`. Fee and net come from the charge's `balance_transaction`, fetched with expansion. If it isn't available yet, it's left NULL and filled in by reconciliation.

### 8.5 Edge-case matrix

| # | Case | Handling |
|---|---|---|
| T1 | The webhook arrives before or after the app's sync | Both go through `upsertSubscriptionFromStripe`, so the result is the same either way |
| T2 | Webhook lost, or server down | Stripe retries for 3 days, the checkout sweep (15 min) catches open sessions, and daily reconciliation catches the rest |
| T3 | The user closes the browser after paying | The webhook or sweep records the payment, and the app's next status check removes the paywall |
| T4 | Async payment or 3-D Secure | Blocked until the subscription is `active`. The app shows "Confirming…". |
| T5 | Events arrive out of order | Fetch the latest from Stripe and compare `provider_updated_at` |
| T6 | Checkout abandoned | Expires after 30 min. The sweep marks it `expired`, and the next request creates a new one. |
| T7 | Server clock drift | All periods and grace dates come from Stripe timestamps |
| T8 | Member-count change payment fails | `pending_if_incomplete`, so the count doesn't change |
| D1 | Double tap, or two admins at once | The row lock runs them one at a time, and the second gets the same open session's URL. Stripe calls use idempotency keys. |
| D2 | Already subscribed | `409`. The app shows "Manage subscription". |
| D3 | Two subscriptions complete anyway (for example, sessions in two browsers) | The duplicate check (§8.6) |
| D4 | Two customers created at once | Unique key plus idempotency key; read the existing row again on conflict |
| D5 | Duplicate across providers (Phases 2–3) | Flagged for review. The admin is told how to cancel through the store. |
| B1 | Forged return or success URL | It has no side effects. `sync` checks ownership server-side. |
| B2 | Someone else's `session_id` | `403` |
| B3 | Test payment trying to unlock a live household | Entitlement only counts rows in the household's own mode |
| B4 | Price or quantity sent by the app | Ignored. The server works out prices from the lookup keys and the size limits (5–10). |
| B5 | Forged or replayed webhook | Signature, 300 s tolerance, unique event ID, mode check |
| B6 | A member (not admin) tries to buy or change the plan | `403` |
| B7 | A modified app skips the paywall screen | The server returns 402 on every feature route |
| B8 | Someone tries to change their own cohort | Only the staff key can, through `/admin`, and every change is logged |
| B9 | Promo-code abuse | `allow_promotion_codes:false` |
| L1 | Failed renewal | Smart Retries, then `past_due`, a 7-day grace period, then blocked (or straight away on `unpaid`) |
| L2 | Cancellation | `cancel_at_period_end`, so access continues until `current_period_end` |
| L3 | Refund | Recorded in the ledger. A full refund **doesn't** cancel the subscription automatically; staff cancel it through the portal or Dashboard if needed. |
| L4 | Dispute | Flagged for review. If lost, the subscription is cancelled at period end. |
| L5 | Reducing members below the current headcount | `409 SEATS_BELOW_MEMBERS` |
| L6 | The purchaser leaves or deletes their account | The subscription belongs to the household and continues. `purchased_by_user_id` is set to NULL. |
| L7 | The household is deleted (after its 30-day purge) | The purge job cancels the Stripe subscription immediately (`prorate:false`) and records it in the ledger and the audit log |
| L8 | The admin role passes to someone else | Billing isn't tied to a person (Stripe). Any current admin can manage it. |

### 8.6 Duplicate-subscription check
After any subscription write, the check counts the allowed subscriptions for (household, mode). If there's more than one:
1. Keep the **oldest**.
2. Cancel the others immediately and refund their latest paid invoice in full (idempotency key `dup:{subId}`).
3. Add a `needs_review` item, email staff and the household admin, and record the refund in the ledger.

---

## 9. Reconciliation

The rule: **Stripe is the source of truth.** Every run takes a Redis lock (`billing:reconcile:{mode}`, TTL 30 min). If Redis is down, it uses `GET_LOCK()` in MySQL instead.

| Job | Schedule | What it does |
|---|---|---|
| Checkout sweep | Every 15 min | For `open` sessions older than 5 min: fetch from Stripe; `complete` → sync; `expired` → mark it |
| Failed-event retry | Every 15 min | `billing_events.failed` with fewer than 5 attempts → fetch the event (`events.retrieve`) and process it again. After 5 attempts → `needs_review`. |
| Daily | 03:30 UTC, per mode | (a) subscriptions changed in the last 48 h (`subscriptions.list`, `status:'all'`); (b) every local subscription that's allowed, re-fetched; (c) invoices, refunds and disputes created in the last 48 h → ledger rows (unique key, so no duplicates); (d) ledger rows with NULL fee → fill from the balance transaction |
| Weekly | Sunday 04:00 UTC | Same, for every subscription and the last 35 days |
| Manual | `POST /admin/billing/reconciliation/run {mode, kind}` | On demand |

Results go into `billing_reconciliation_items`:
- **Fixed automatically:** status, period, member count, price or amount, or `cancel_at_period_end` differ; a ledger row or fee is missing; a checkout row is stale.
- **Needs review:** an unmatched customer or invoice; more than one allowed subscription (if not already handled by §8.6); a local subscription that no longer exists in Stripe (marked `canceled` *and* flagged); a ledger amount that differs from Stripe after an attempted fix; an event that failed 5 times.

New `needs_review` items → a summary email to `ADMIN_EMAIL`, at most one per run. Staff resolve items through `POST /admin/billing/reconciliation/items/:id/resolve {resolution:'resolved'|'ignored', note}`.

---

## 10. Admin API (staff)

Mounted at `/api/v1/admin/billing` and protected by `ADMIN_BILLING_API_KEY` (header `x-admin-billing-key`), which is separate from `ADMIN_API_KEY`. Every request goes into `admin_audit_log`. Paging uses a cursor (`?cursor&limit≤200`), with responses shaped `{ success, data, nextCursor }`. Every endpoint is documented in OpenAPI (`@openapi` JSDoc).

| Method and path | Purpose |
|---|---|
| `GET /transactions` | Filters: `mode` (default `live`), `householdId`, `userId`, `email`, `type`, `status`, `matchStatus`, `from`, `to`. Each row includes household name, payer email, amount, fee and net, and a Stripe Dashboard link (`https://dashboard.stripe.com/{test/}…`). |
| `GET /transactions/:id` | One transaction, with its subscription and household |
| `GET /transactions.csv` | Same filters, streamed |
| `GET /summary?mode&from&to` | Gross, refunds, disputes, fees, net, MRR (yearly plans divided by 12), counts of active, past-due and in-grace subscriptions, and failed payments |
| `GET /households/:id` | Cohort, entitlement, subscriptions (all modes, labelled), members, recent transactions |
| `GET /subscriptions?mode&status` | List |
| `GET /reconciliation/runs`, `GET /reconciliation/items?status=needs_review` | Review |
| `POST /reconciliation/run`, `POST /reconciliation/items/:id/resolve` | Act |
| `POST /households/:id/cohort {cohort, reason}` | Change cohort. Clears the entitlement cache and writes to the audit log. |
| `GET /routing`, `PUT /routing {rules:[{platform,country,method}]}` | Routing rules (replaced in a single transaction) |

---

## 11. Routing rules (where purchases go)

- The app sends `X-Platform: ios|android|web` and `X-Country`: the device region in Phase 1, the App Store storefront in Phase 2, the Play billing country in Phase 3.
- Resolution: an exact `(platform, country)` rule, then `(platform, '*')`, then the default `stripe_checkout`.
- `purchaseMethod` in `/billing/status` tells the app which flow to start. In Phase 1, the app can only start `stripe_checkout`. Any other method makes it show "Purchasing isn't available on this device yet. Manage your subscription at rootaroo.com", so changing a rule never crashes an older build.
- The server refuses `POST /billing/checkout` when the resolved method for the caller isn't `stripe_checkout` (`409 PURCHASE_METHOD_MISMATCH`).

---

## 12. Testing

1. **Unit (Jest, Stripe mocked):** `resolveMode`, the startup checks, `getEntitlement` across cohort × status × grace × mode, the catalog and cache clearing, routing resolution, the member limit, linking ledger rows, how reconciliation sorts mismatches, and the duplicate check. **Target ≥90% coverage for `modules/billing`.**
2. **Integration (supertest, real MySQL `rootaroo_test`, signed payloads from `generateTestHeaderString`):** bad signature → 400; wrong mode → 400; the same event twice → handled once; `updated` before `created` → correct final state; two concurrent `/checkout` calls → one session; two subscriptions → newer cancelled and refunded (Stripe mocked); a foreign `sync` → 403; a non-admin → 403; a price sent by the app → ignored; every feature route → 402 when blocked, while auth, households, billing and account deletion still work; a concurrent join at the member limit → exactly one succeeds.
3. **End to end in Stripe test mode** (real Stripe test API, `stripe listen --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test`, Checkout completed in Chrome):
   - monthly with 5 members, yearly with 7, using card `4242 4242 4242 4242`;
   - 3-D Secure with `4000 0025 0000 3155`;
   - declined with `4000 0000 0000 9995`;
   - test clock: renewal → payment failure (`4000 0000 0000 0341`) → grace → blocked → payment updated → restored;
   - add and remove members;
   - cancel in the portal;
   - refund;
   - dispute (`4000 0000 0000 0259`);
   - missed webhook: listener stopped → sweep and reconciliation;
   - deliberately corrupted rows → reconciliation fixes them;
   - test-cohort bypass;
   - a test payment can't unlock a live household;
   - the admin endpoints: ledger linking, CSV, summary, review queue, cohort and routing changes.
4. **App:** checkout, return to the app, the paywall and the subscription screen on the Android emulator (dev client). A manual checklist for iOS on a device.
5. **Phases 2–3:** a device test checklist (Apple sandbox and StoreKit config, Play licence testers and internal testing track) for the owner to run.

---

## 13. Restricted key permissions (Phase 1)

Write: Customers, Checkout Sessions, Subscriptions, Customer Portal (Billing portal sessions + configurations), Refunds. Read: Prices, Products, Invoices, Charges, Balance transactions, Disputes, Events, Early fraud warnings. The bootstrap script uses a separate, broader key, run once per mode by staff: write access to Products, Prices, Webhook endpoints and Portal configurations.

---

## 14. Out of scope for Phase 1, and decisions before launch

- **Universal links** (`apple-app-site-association` and `assetlinks.json` on rootaroo.com) before App Store submission.
- **Stripe Tax:** decide between Stripe Tax with state registrations and Managed Payments (merchant of record). Until then, `automatic_tax` stays **off**, and prices don't include tax.
- **App Review:** US storefront link-out under Guideline 3.1.1(a). Re-check the rules when submitting. The routing rules are the switch if they change.
- Accessibility, localized prices, other currencies (`currency_options`).

---

## 15. Phase 2 (Apple IAP) and Phase 3 (Google Play), contracts only

- **Products:** one auto-renewing subscription per (interval × household size 5–10), so 12 products per store, in one subscription group (Apple) or one subscription with base plans (Google). Product IDs `rootaroo.household.{month|year}.{5..10}`. Store prices are matched to the Stripe totals as closely as the stores' price points allow.
- **Server:** the same `billing_subscriptions`, `billing_transactions` and `billing_events` tables with `provider='apple'|'google'`. Apple: App Store Server API + App Store Server Notifications V2, with `sandbox` vs `production` mapped to `livemode`. Google: Play Developer API + Real-time Developer Notifications (Pub/Sub push), with license-tester purchases mapped to `livemode=false`. `appAccountToken` (Apple) and `obfuscatedAccountId` (Google) are set to the household ID, to link purchases to households.
- **Cross-provider:** the one-allowed-subscription rule and the duplicate check apply across providers. Apple and Google subscriptions can't be cancelled by us, so a duplicate is flagged for review.
- **Ownership caveat:** a store subscription is tied to the buyer's store account. If that admin leaves, the household gets the 7-day grace period to resubscribe, and the leave flow warns them first.
- **App:** a native IAP module (for example `expo-iap`) requires a new EAS build. Restore purchases and the storefront country feed into routing.
