# Wave 8 gate evidence: staff billing-admin API

Date: 2026-10-03. Branch feat/billing. DB: Docker MySQL rootaroo-mysql-impl:3307 (rootaroo_test for tests, rootaroo_impl for the live check).

## Commits

- 888e4fa2 Task 8.0: unique plan-change idempotency key per applied change (migration `20261005-add-plan-change-version-to-billing-subscriptions.js`)
- 3ada8d37 8.1 auth, IP allowlist, audit log on both surfaces
- 729c9a08 8.2 transactions list, detail, CSV
- 2b63af41 8.3 summary, subscriptions, household view
- d71101b3 8.4 review queue, manual reconciliation, event replay
- 0f51986c 8.5 cohort changes, routing API, combined coverage gate

## Gate results

| Check | Result |
|---|---|
| `npx jest` (unit) | 54 suites, 729 tests, all pass |
| `npm run type-check` | clean |
| `npm run lint` | 0 errors, 179 warnings (no-explicit-any in tests, same class as before) |
| `npm run test:int` | 28 suites, 191 tests, all pass |
| `npm run test:billing-coverage` (unit + int, 82 suites, 920 tests) | pass; thresholds met |

Billing coverage (`src/modules/billing/**`, scripts excluded): statements 93.16 %, branches 82.9 %, functions 95.17 %, lines 95.36 %. `billing/admin`: lines 97.52 %. No extra tests were needed. The coverage run took about 23 minutes and was executed on the final tree (no code changes after it).

## Task 8.0

Key was `plan:{subId}:{interval}:{seats}:{currentPeriodStart}`. A -> B -> A -> B inside one period replayed Stripe's cached response for the third change. Now `plan:{subId}:{interval}:{seats}:v{planChangeVersion}`, where `billing_subscriptions.plan_change_version` is incremented (under the checkout lock) only after Stripe accepted the update. A failed attempt retries with the same key; each applied change gets a fresh one.
Tests (`planPortal.int.test.ts`): "A -> B -> A -> B in one period uses a fresh idempotency key for every applied change" (written first, failed with 2 distinct keys instead of 3) and "a failed Stripe call does not advance the key, so the retry dedupes".

## API surface (`/api-docs.json`)

21 paths start with `/billing`: 7 user routes (`/billing/return/{result}`, `plans`, `checkout`, `checkout/{sessionId}/sync`, `status`, `portal`, `plan`) and 14 `/billing-admin/*` routes (`ping`, `transactions`, `transactions.csv`, `transactions/{id}`, `summary`, `subscriptions`, `households/{id}`, `households/{id}/cohort`, `reconciliation/runs`, `reconciliation/items`, `reconciliation/run`, `reconciliation/items/{id}/resolve`, `events/{id}/replay`, `routing`). Security scheme `billingAdminKey` = apiKey, header `x-admin-billing-key`.

## Live check (dev server on PORT 3999 against rootaroo_impl, Stripe test mode)

Keys were read from the environment and never printed. `npx sequelize-cli db:migrate` was run against rootaroo_impl first (it applied the 8.0 migration; the first summary call returned 500 `Unknown column 'plan_change_version'` until then, which is what `npm run dev` would have done automatically).

| Request | Response |
|---|---|
| `GET /billing-admin/summary?mode=test` with the billing key | 200 `{"success":true,"data":{"mode":"test","currency":"usd","gross":0,"refunds":0,"disputes":0,"fees":0,"disputeFees":0,"net":0,"mrr":0,"counts":{"active":0,"pastDue":0,"inGrace":0,"failedCyclePayments":0},...}}` |
| same call with `ADMIN_API_KEY` as `x-admin-billing-key` | 401 `{"success":false,"error":"Invalid or missing billing admin key","code":"UNAUTHORIZED"}` |
| `GET /admin/requests` with `ADMIN_BILLING_API_KEY` as `x-admin-api-key` | 401 `{"success":false,"error":"Invalid or missing admin API key","code":"UNAUTHORIZED"}` |
| `GET /admin/requests` with `ADMIN_API_KEY` | 200 |
| `GET /billing-admin/ping` without a key | 401 |
| `GET /billing-admin/ping` | 200 `{"success":true,"data":{"ok":true}}` |
| `GET /billing-admin/transactions?mode=test&limit=2` | 200 `{"success":true,"data":[],"nextCursor":null}` |
| `GET /billing-admin/subscriptions?mode=test` | 200 `{"success":true,"data":[],"nextCursor":null}` |
| `GET /billing-admin/reconciliation/runs?mode=test&limit=1` | 200, the W7 weekly run `2161a970-...`, status `succeeded` |
| `GET /billing-admin/reconciliation/items?mode=test&status=needs_review` | 200, empty |
| `GET /billing-admin/routing` | 200, 3 default rules (web, ios, android: `stripe_checkout`) |
| `GET /billing-admin/transactions.csv?mode=test` | 200, `text/csv`, header row only |
| `GET /billing-admin/transactions.csv?cursor=bm9wZQ` | 400 `Invalid cursor` (rejected before streaming) |

The server was stopped afterwards (port 3999 free).

## Deviations from the plan

- Commit trailer is the single `Co-Authored-By` line as instructed (no Claude-Session line).
- Admin CSV export prefixes cells that start with `=`, `+`, `-`, `@`, tab or CR with a quote (household names and emails are user-controlled), and aborts the response on a mid-stream failure instead of ending a truncated body as a valid CSV.
- `replayEvent` uses a conditional update (`status != 'processing'`) and returns 409 `EVENT_PROCESSING` when a worker holds the event; the plan would have reset a row mid-processing.
- `changeCohort` runs under the checkout lock (`billing:checkout:{household}:{mode}`) so a session cannot open between the L9 check and the switch.
- `@openapi` blocks: `{ description: Rule[] }` is invalid YAML in a flow map (swagger-jsdoc logged YAMLSemanticError); quoted.
- `test:billing-coverage` runs Jest under `node --max-old-space-size=8192` (the combined run hit the default 2 GB heap) and sets `testTimeout` at the top level of the coverage config (Jest ignores it inside a project config).
- Plan's 8.1 unit test file was extended with tests for `requireBillingAdminKey` and `auditLog` (digest only, never the body).
- The old test "retries of the same change reuse the same deterministic idempotency key" (two successful identical changes) was replaced by the failed-call retry test, since a second identical change is now a distinct applied change by design.
- The summary test also covers a past_due subscription whose grace has expired (counted in `pastDue`, not in `inGrace` or MRR).

## Open issues

- `upsertSubscription` does not write `plan_change_version`; a subscription row recreated from scratch restarts at 0, which is harmless (the counter only needs to differ between applied changes on the same Stripe subscription, and a recreated row means a new Stripe subscription id in practice).
- `changeCohort --force` cannot cancel Apple/Google subscriptions (skipped); Phase 2-3 should handle that.
- The audit log stores the request query string verbatim, including the `email` filter on `/transactions`; it holds no keys or bodies.
