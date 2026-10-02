# Wave 3 gate results (catalog, bootstrap, GET /billing/plans)

Commits: 3.1 `39536d35`, 3.2 `cfeb5282`, 3.3 `3cdd7e37`.

| Check | Result |
|---|---|
| `npx jest` (unit) | PASS: 34 suites, 497 tests (W2: 31/467) |
| `npm run type-check` | PASS |
| `npm run lint` | PASS, 0 errors, 133 warnings (W2: 115; new warnings are `no-explicit-any` in test helpers/mocks) |
| `npm run test:int` (single full run, rootaroo_test on Docker MySQL 3307) | PASS: 4 suites, 11 tests (harness, locks, models, plans) |
| `npm run billing:bootstrap -- --mode test --skip-webhooks` (re-run) | all 12 lookup keys `exists`, portal configuration `updated`; nothing created. First-run output in `w3-bootstrap.md` |
| Plans against the real sandbox | `getPlansForMode('test')` (the exact function behind the route) returned priceSet 2026-10, usd, month 5..10 = 899 1098 1297 1496 1695 1894, year 5..10 = 7999 10387 12775 15163 17551 19939 (all 12 match section 6.1). The HTTP route is covered by `plans.int.test.ts` with the Stripe mock (200 / 403 NO_HOUSEHOLD / 401). A live token HTTP call was not made (no real dev user token available to the agent). |

Stripe sandbox objects (test mode, dev account): 6 products (prod_VMwx...), 12 prices (lookup keys rootaroo_hh5..10_month/year), 1 portal configuration (bpc_1UMD44...). No webhook endpoints, no live-mode objects.

Deviations from plan: `stripeMock.ts` uses `jest.fn<any, any[]>()` (plan's `jest.fn()` fails tsc on `mockImplementation((p) => ...)`); `toCatalogPrice` casts `interval as BillingInterval` (Stripe SDK 23 types include `OtherString`); bootstrap tests pass `expect.anything()`/options for the second `create` argument (idempotencyKey), which the plan's assertions omitted.

Open items for the orchestrator: sandbox Terms of Service URL (Settings > Public details) not confirmed; a live-token `GET /api/v1/billing/plans` spot-check with `npm run dev`.
