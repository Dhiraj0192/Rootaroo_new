# Billing runbooks

Operational procedures for staff. Overview: [`README.md`](./README.md). Design: spec sections 4, 10, 11, 12, 14, 15.

Conventions used below (placeholders; never paste real values into tickets, chat or commits):

- `<API>`: the API origin for the environment, for example the value of `BILLING_PUBLIC_BASE_URL`.
- Staff calls use the header `x-admin-billing-key: $ADMIN_BILLING_API_KEY`. Load the key into your shell from your secret
  store; do not echo it. The staff key never works on the general admin API and vice versa.
- `<MODE>` is `test` or `live`. Live commands also need `--confirm-live`.
- `<ID>` is a UUID from the staff API.
- Bootstrap commands run from `server/` with the environment loaded (`BILLING_ENV_TAG`, `STRIPE_<MODE>_SECRET_KEY` or
  `STRIPE_BOOTSTRAP_<MODE>_KEY`, `BILLING_PUBLIC_BASE_URL`).

Shell helper for the curl examples:

```bash
BA() { curl -sS -H "x-admin-billing-key: $ADMIN_BILLING_API_KEY" -H 'content-type: application/json' "$@"; }
BA "<API>/api/v1/billing-admin/ping"      # expect {"ok":true}
```

Every staff request is recorded in `admin_audit_log`.

---

## 1. API key rotation and restricted keys

**When:** before launch (replace any key ever pasted into chat, tickets or logs), on a schedule, on staff change, or on suspected leak.

**Restricted key permissions (spec section 14)**
- Runtime key per environment. Write: Customers, Checkout Sessions, Subscriptions, Billing Portal sessions, Refunds.
  Read: Customers (including search), Prices, Products, Invoices, Invoice Payments, PaymentIntents, Charges,
  Balance transactions, Disputes, Events, Early fraud warnings, Refunds.
- Bootstrap key (staff only, per environment). Write: Products, Prices, Webhook endpoints, Portal configurations.

**Steps**
1. In the Stripe Dashboard for the right account/sandbox, create a new restricted key with the permissions above. Name it with the date.
2. Set the new value in the host platform's environment settings: `STRIPE_TEST_SECRET_KEY` (test sandbox) or
   `STRIPE_LIVE_SECRET_KEY` (live, production only). For bootstrap use `STRIPE_BOOTSTRAP_TEST_KEY` / `STRIPE_BOOTSTRAP_LIVE_KEY`.
3. Redeploy or restart the server. Startup checks refuse a test key in a live variable (and the reverse).
4. Wait until healthy, then revoke or roll the old key in the Dashboard (a "roll" may keep the old key valid for a grace period; set it to expire quickly).

**Verification**
- Server starts without a billing config error.
- `GET <API>/api/v1/billing/plans` returns plans (needs Prices/Products read).
- Trigger a reconcile for the mode: `BA -X POST <API>/api/v1/billing-admin/reconciliation/run -d '{"mode":"<MODE>"}'`, then
  `BA "<API>/api/v1/billing-admin/reconciliation/runs?mode=<MODE>"` shows `status` success.
- A test-mode checkout creates a session (no `permission` errors in logs).
- Never commit key values; the pre-commit hook runs the secret scan.

**Rollback:** re-set the previous key value only if it has not been revoked; otherwise create another new key. A missing or
rejected key turns the mode off for checkout (503 `BILLING_MODE_UNAVAILABLE`) without data loss, and webhooks keep verifying
because they use signing secrets, not API keys.

---

## 2. Webhook signing secret rotation (multiple secrets)

**When:** scheduled rotation, suspected leak, or after re-creating an endpoint.

`STRIPE_TEST_WEBHOOK_SECRETS` and `STRIPE_LIVE_WEBHOOK_SECRETS` accept a comma-separated list; an event is accepted if it
verifies against any secret in the list, so rotation needs no downtime.

**Steps**
1. In the Dashboard, open the endpoint (`<API>/api/v1/billing/webhooks/stripe/<MODE>`) and roll the signing secret. Choose an
   expiry for the old secret (for example 24 hours) so Stripe signs with both during the overlap. If your plan only gives one active secret, skip to step 3 after setting the new one first.
2. Set `STRIPE_<MODE>_WEBHOOK_SECRETS` to `<new>,<old>` (new first) and redeploy.
3. After the overlap and after confirming events verify with the new secret, set the variable to `<new>` only and redeploy.
4. If the endpoint does not exist yet (or was deleted), run
   `npm run billing:bootstrap -- --mode <MODE>` (plus `--confirm-live` for live). It registers the endpoint (https base URL required)
   and prints the endpoint id; reveal the signing secret in the Dashboard.

**Verification**
- In the Dashboard, send a test event to the endpoint: HTTP 200. A bad secret gives 400.
- `billing_events` shows the new event as `processed` (staff: `GET /billing-admin/reconciliation/items?status=needs_review` shows no dead-event items).

**Rollback:** put the old secret back at the front of the list. Events missed while the endpoint returned 400 are retried by
Stripe for up to three days; anything older is recovered by the daily reconcile (or run it manually, section 7).

---

## 3. Review queue triage

**When:** a "reconciliation needs review" summary email arrives, a dead-event alert fires, or daily as routine.

**Item types:** unmatched customer/invoice/subscription, more than one allowed subscription not auto-resolved, local subscription
missing in Stripe (already marked canceled), amount still differing after a fix, dead events.

**Steps**
1. List open items: `BA "<API>/api/v1/billing-admin/reconciliation/items?mode=<MODE>&status=needs_review"` (cursor paginated).
2. For each item, open the linked Stripe object in the Dashboard and the household: `BA <API>/api/v1/billing-admin/households/<ID>`
   (entitlement, subscriptions of every mode, customers, members, recent transactions).
3. Decide:
   - Real drift that auto-fix could not resolve: correct the cause (for example link the customer, cancel the duplicate in Stripe,
     replay the event, section 7), then re-run reconcile for that mode.
   - Duplicate subscriptions: keep the healthy one (active beats past_due, then oldest); cancel and refund the other in the Dashboard (section 4).
   - Not actionable (foreign environment object, test noise): resolve as `ignored`.
4. Resolve with a note: `BA -X POST <API>/api/v1/billing-admin/reconciliation/items/<ID>/resolve -d '{"resolution":"resolved","note":"what was done"}'`
   (`resolution` is `resolved` or `ignored`).

**Verification:** the item no longer appears under `needs_review`; the next reconcile run does not re-raise it
(`GET /reconciliation/runs?mode=<MODE>`).

**Rollback:** resolutions are notes on the item; if a fix was wrong, undo it at the source (Stripe) and run reconcile again.
A re-raised item means the underlying difference remains.

---

## 4. Refunds and disputes

**When:** a customer asks for a refund; a charge is disputed (email from Stripe, or a dispute row in the ledger).

**Refunds**
1. Find the payment: `BA "<API>/api/v1/billing-admin/transactions?mode=<MODE>&email=<payer-email>&type=payment"`; each row has a Stripe Dashboard link.
2. Issue the refund in the Dashboard (full or partial). Cancel the subscription in the same step if the customer is leaving.
3. The `charge.refunded`/refund events create a negative refund ledger row and update the payment status. Entitlement follows the
   subscription state, not the refund, so cancel explicitly if access should end.

**Disputes**
1. A `charge.dispute.*` event writes a dispute row (funds withdrawn, dispute fee). Review it:
   `BA "<API>/api/v1/billing-admin/transactions?mode=<MODE>&type=dispute"`.
2. In the Dashboard, submit evidence before the deadline (receipts, terms acceptance, usage). Win: funds are reinstated and the row updates.
   Lose: the withdrawn amount stands.
3. Cancel the subscription if appropriate.

**Verification:** `GET /billing-admin/summary?mode=<MODE>&from=<ISO>&to=<ISO>` shows gross minus refunds minus dispute amounts minus
fees equals net; the transaction row shows the new status. If a row is missing, run reconcile (section 7).

**Rollback:** refunds and dispute submissions cannot be undone in Stripe. Wrong ledger state (not money) is repaired by replaying
the event or running reconcile.

---

## 5. Cohort changes (including `force`)

**When:** a household must be moved between `live` and `test` billing (support testing, internal accounts, launch cohorts).
Only meaningful in production; elsewhere every household is already `test`.

**Steps**
1. Check the household: `BA <API>/api/v1/billing-admin/households/<ID>`.
2. Change it: `BA -X POST <API>/api/v1/billing-admin/households/<ID>/cohort -d '{"cohort":"test","reason":"short reason"}'`.
3. If the household has an allowed subscription or open checkout in its current mode the call is refused with
   `COHORT_CHANGE_BLOCKED` (409). Decide deliberately. Re-send with `"force":true` to proceed: this sets
   `cancel_at_period_end` on the existing subscription(s) and expires open Checkout sessions. IAP (Apple/Google) subscriptions
   cannot be cancelled by the server; they appear as a review item and must be handled by the customer in the store.
4. The entitlement cache is cleared by the change and the action is audited with `from`, `to`, `reason`, `force`.

**Verification:** `GET /billing-admin/households/<ID>` shows the new cohort and the expected entitlement; `GET /billing/status`
as that household reflects it.

**Rollback:** set the previous cohort again (same endpoint). `force` effects are not auto-reverted: remove `cancel_at_period_end`
in the Stripe Dashboard if it was set by mistake, and let the customer start a new checkout if the session was expired.

---

## 6. Price changes and migrations

**When:** new prices for new customers, or moving existing subscribers to a new price set. Price sets are named `YYYY-MM`.
Prices are never edited; new ones are created and the catalog points at the newest active set via lookup keys.

**A. New prices for new customers**
```bash
cd server
npm run billing:bootstrap -- --mode <MODE> --set-prices <YYYY-MM> \
  --month-base <cents> --month-extra <cents> --year-base <cents> --year-extra <cents>   # live: add --confirm-live
```
This creates all 12 prices tagged with the new set (transferring lookup keys) and publishes a catalog cache-bust.
Existing subscribers keep their current price (grandfathered): a plan change picks prices from the subscription's own set while it is active.

**B. Moving existing subscribers (optional)**
```bash
npm run billing:bootstrap -- --mode <MODE> --migrate-prices --from <YYYY-MM> --to <YYYY-MM> --notice-days 30   # live: add --confirm-live
```
`--notice-days` must be 30 or more. It writes a price notice per allowed subscription and emails/notifies household admins. The daily
price-notice job swaps the price (no proration) after the notice period and at least 48 hours before renewal; cancelled
subscriptions are skipped.

**C. Backfill:** `--backfill` runs a weekly-style reconcile after bootstrap.

**Verification**
- `GET <API>/api/v1/billing/plans` shows the new amounts (cache clears across instances within minutes).
- Dashboard: new prices have `lookup_key` set and metadata `price_set=<YYYY-MM>`.
- For migrations: `billing_price_notices` rows are `scheduled`, then `applied`; subscriptions show the new price after the next period.

**Rollback:** run `--set-prices` again with the previous amounts under a new set name (sets are immutable). Migration notices that are
still `scheduled` can be marked skipped in the database by an engineer; applied swaps are reverted only by another migration (with a new notice period) or a manual Dashboard edit.

---

## 7. Routing changes

**When:** enabling or restricting a purchase method by platform and store country (for example enabling Stripe link-out in a country
after the store-rule review, or turning IAP on for a storefront).

**Steps**
1. Read the current rules: `BA <API>/api/v1/billing-admin/routing`.
2. Replace the full rule set (one transaction, audited). Rules are `{platform: ios|android|web, country: "XX"|"*", method: stripe_checkout|apple_iap|google_play|none}`:
```bash
BA -X PUT <API>/api/v1/billing-admin/routing -d '{"rules":[
  {"platform":"ios","country":"*","method":"apple_iap"},
  {"platform":"ios","country":"US","method":"stripe_checkout"},
  {"platform":"android","country":"*","method":"google_play"},
  {"platform":"web","country":"*","method":"stripe_checkout"}
]}'
```
(The rules above are an example shape, not a recommendation; apply the store-policy decision recorded for release.)
Resolution is exact (platform, country), then (platform, `*`), then none. Test cohort and non-production always get `stripe_checkout`.

**Verification:** `GET /billing-admin/routing` returns the new set; a client with the matching `X-Platform` and `X-Store-Country`
headers sees the expected `purchaseMethod` in `GET /billing/status`.

**Rollback:** PUT the previous rule set (copy it from step 1 or from the audit log).

---

## 8. Event replay and reconciliation failures

**Event replay** (a handler failed, a dead event, or a bug was fixed after delivery)
1. Find the event: it is in `billing_events` (id from the review item or alert email).
2. `BA -X POST <API>/api/v1/billing-admin/events/<ID>/replay`.
3. Verify the status becomes `processed` and the ledger/subscription is correct. Handlers are idempotent; replay is safe.
4. If it keeps failing, fix the cause (often an unmatched household or a code defect), then replay.
Rollback: not needed (idempotent). A replayed event that is stale cannot overwrite newer subscription state because
`upsertSubscription()` re-fetches from Stripe.

**Reconciliation run now:** `BA -X POST <API>/api/v1/billing-admin/reconciliation/run -d '{"mode":"<MODE>"}'`.

**Reconciliation failure alert** (run failed or exceeded 30 minutes)
1. `BA "<API>/api/v1/billing-admin/reconciliation/runs?mode=<MODE>"`: read the error on the latest run.
2. Typical causes: Stripe key lacks a read permission (section 1), Stripe outage/rate limit (wait and re-run), lock held by a crashed
   instance (locks expire on their TTL), DB connectivity.
3. Fix the cause and run again. Missed events are never lost: the weekly run paginates everything for the last 35 days.
4. Check the event sweep is alive (events stuck in `received` or `failed` for more than a few minutes mean the sweep or worker is not running).

Verification: latest run `success`, no new `needs_review` items from the same cause.

---

## 9. Going live checklist

Complete in order; all items are release gates (spec section 15 plus the above runbooks).

- [ ] Universal links: `apple-app-site-association` and `assetlinks.json` hosted on the production domain; Checkout return URLs moved to them.
- [ ] Tax decision: Stripe Tax with registrations, or Managed Payments. Until decided, `automatic_tax` stays off.
- [ ] App Store Review: current Guideline 3.1.1(a) checked for the link-out countries; routing rules recorded in the review notes.
- [ ] Google Play: alternative billing / external offers declarations completed where Stripe is offered.
- [ ] Stripe Dashboard per environment: customer receipts, renewal reminders, Smart Retries, "cancel after all retries", public details
      including the Terms of Service URL, portal configuration (set by bootstrap).
- [ ] Keys: restricted keys created per environment (section 1), any key ever shared in chat rolled, webhook secret rotation rehearsed (section 2).
- [ ] Production env: `NODE_ENV=production`, `BILLING_ENV_TAG=prod`, `STRIPE_TEST_*` (prod-test sandbox) and `STRIPE_LIVE_*` set,
      `BILLING_PUBLIC_BASE_URL` https, `ADMIN_BILLING_API_KEY` (32+ chars) and `ADMIN_BILLING_IP_ALLOWLIST` set, `ADMIN_EMAIL` set,
      `BILLING_REQUIRE_TOS_CONSENT` not `false`.
- [ ] Run bootstrap for both modes: `npm run billing:bootstrap -- --mode test` and `--mode live --confirm-live`; register both webhook endpoints and store the signing secrets.
- [ ] Apple/Google IAP (if enabled): env vars set (see README), notification URLs configured, [`device-test-checklist.md`](./device-test-checklist.md) passed on real devices.
- [ ] Routing rules set (section 7); test cohort assigned to internal households (section 5).
- [ ] Staff API reachable only from allowed IPs; `GET /billing-admin/ping` OK.
- [ ] Alert path verified (a test reconcile summary or alert email reaches `ADMIN_EMAIL`).
- [ ] One live end-to-end purchase with a real card on an internal household, refunded afterwards; ledger and summary checked.
- [ ] Runbooks read by the on-call staff.

**Rollback of go-live:** money already taken is not reversed by config. To stop new live sales, set routing to `none` for the affected
platforms (section 7). Do not remove the live keys in production (startup requires them and webhooks/reconcile for existing subscribers
must keep running). Refund individual payments as in section 4.
