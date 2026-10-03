# Wave 6 evidence: ledger, event handling, webhook receiver, deletion hooks

Branch feat/billing. Tasks 6.1 to 6.5 committed (ledger, dispatch table, worker + sweep, raw-body receivers, deletion hooks).

## Gate results

| Check | Result |
|---|---|
| `npx jest` (unit) | 50 suites, 700 tests passed |
| `npm run type-check` | exit 0 |
| `npm run lint` | 0 errors, 158 warnings (baseline had 155; new warnings are `any` in tests) |
| `npm run test:int` | 19 suites, 127 tests passed; process exits by itself (exit 0, about 355 s, no force exit, no open-handle warning) |
| Coverage, `modules/billing`, unit suite only | 55.3% statements / 49.4% branches / 52.8% functions / 57.2% lines |

Coverage note: the 80% unit-only target is NOT met. Per file (statements): handlers 100, webhooks 100, worker 95.5, notify 96, locks 96, ledger 35.7 (DB paths are covered by the int suite only), deletion 0, plan 0, routes/controller/webhookRoutes 0 (int-covered). Unit coverage of int-covered modules is raised in later waves (W8 requires 90%).

## Live webhook check (Stripe test mode, dev server on rootaroo_impl)

`stripe listen --events customer.created,customer.updated --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test`, server started with the printed signing secret in `STRIPE_TEST_WEBHOOK_SECRETS` (stored only in gitignored server/.env.impl). `stripe trigger customer.updated` produced:

```
--> customer.created [evt_1UMLN70dWk0w8nqYMWhZ5EC4]
<--  [200] POST http://localhost:3000/api/v1/billing/webhooks/stripe/test
--> customer.updated [evt_1UMLN80dWk0w8nqY1wpkdC1m]
<--  [200] POST http://localhost:3000/api/v1/billing/webhooks/stripe/test
```

billing_events rows (rootaroo_impl):

| provider_event_id | type | status | attempts | livemode |
|---|---|---|---|---|
| evt_1UMLN80dWk0w8nqY1wpkdC1m | customer.updated | processed | 0 | 0 |
| evt_1UMLN70dWk0w8nqYMWhZ5EC4 | customer.created | ignored | 0 | 0 |

Both rows were completed within the same second. Server and listener were stopped afterwards.

## Deviations
- `stripe listen` requires `--events` (or `--all-snapshot`), so the command in the plan was extended with `--events`.
- The CLI reports API version 2026-07-29.dahlia; irrelevant to signature verification, payloads are re-fetched from Stripe at the pinned version in `upsertSubscription`.
- Sweep: rows reset from stale `processing` are re-queued immediately instead of waiting for backoff (plan test T2 required it).
- Webhook limiter wrappers named `rateLimitGate` / `authRateLimitGate` (as planned); `coverage/` added to server/.gitignore.
- Commit trailer is a single Co-Authored-By line (coordinator instruction) rather than the plan's two lines.
- Added unit tests `webhooks.test.ts` and `worker.test.ts` beyond the plan.

## Open issues
- Unit-only billing coverage 55% vs 80% target (see above).
- Webhook listener API version differs from pinned version (informational).

## Review fixes
Code-review findings fixed test-first on `feat/billing`. Commits: A `6998deeb`, B `7c8d87dd`, C `1d081cf3`, D `0481d214`, E (this commit: flake fix and evidence).

| # | Finding | Commit | Test(s) |
|---|---|---|---|
| 1 | Replayable `hh-delete` idempotency key | A | `deletion.int.test.ts` "schedule -> cancel -> reschedule within 24 h never replays a cached Stripe response" |
| 2 | Fire-and-forget deletion hooks lose failures; no drift check | A | `deletion.int.test.ts` "reportDeletionHookFailure raises a needs_review item"; `household.service.test.ts` "raises a review item ... scheduled/cancelled hook fails"; `reconcile.int.test.ts` "deletion drift" (2 tests) |
| 3 | `invoice.paid` / `payment_failed` recorded before upsert | B | `handlers.test.ts` "upsert the subscription BEFORE recording the invoice"; `ledger.test.ts` "fills null userId/subscriptionId ..." |
| 4 | Deleted purchaser's email stored in ledger | B | `ledger.int.test.ts` "ledger: deleted purchasers" (5 tests incl. `anonymizeUserLedger` by email snapshot) |
| 5 | Checkout allowed with past_due / lost customer | C | `checkout.int.test.ts` "existing-subscription guards" (3 tests) |
| 6 | Duplicate refund scope and notification text | D | `duplicates.int.test.ts` "does not refund an invoice that was paid before the keeper existed", "refunds an invoice paid inside the overlap window", "tells the admin when the refund failed" |
| 7 | Duplicate resolution unlocked, direct writes | D | `duplicates.int.test.ts` "concurrent resolutions cancel once and send one email", "cancelling does not recurse", `lastSyncedAt` assertion in the D3 test |
| 8 | `changePlan` with a pending update; non-deterministic key | C | `planPortal.int.test.ts` "pending update and idempotency" (4 tests) |
| 9 | Customer-create key not tied to params | C | `checkout.int.test.ts` "creates a session ..." (key = hash of params) |
| 10 | Sweep overwrote rows that finished meanwhile | D | `worker.int.test.ts` "the sweep does not clobber a row that finished after it was read"; `worker.test.ts` sweep test |
| 11 | Purchaser-deletion failure used `livemode: false` | A | `deletion.int.test.ts` "reportPurchaserDeletionFailure ..." (2 tests); `auth.service.test.ts` "passes the original email ... reports a failure" |
| 12 | Lock TTL expiry and MySQL fallback pool starvation | D | `locks.test.ts` "withLock heartbeat and MySQL slots" (2 tests) |

Notes:
- Finding 8 uses the requested key `plan:{subId}:{interval}:{seats}:{currentPeriodStart}`. Repeating the exact same change within one period and 24 h (A to B, B to A, A to B) replays Stripe's cached response; the 409 guard and the no-op check make this unlikely, but it is a known limit of that key shape.
- Finding 1 drops the key entirely; the local `cancelAtPeriodEnd === value` check plus `billing:hhdel:{household}` lock serialise flips.

### Flaky `webhooks.int.test.ts`
Reproduced once in three full `test:int` runs (run 2): `resetDb()` in `beforeEach` failed on `TRUNCATE` in "400 on a bad or missing signature". Root cause: the preceding tests (valid event, rotation secret, concurrent duplicates) respond 200 and leave the event in the in-process background worker, which was still querying MySQL when the next test truncated tables. Fix: `beforeEach` awaits `__drainForTests()` before `resetDb()`. Runs 1 and 3 were green (163/163).
