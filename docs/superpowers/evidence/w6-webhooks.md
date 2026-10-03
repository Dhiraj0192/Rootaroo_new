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
