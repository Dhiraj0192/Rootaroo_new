# Wave 7 gate evidence: reconciliation, sweeps, price notices, alerting

Date: 2026-10-03. Branch feat/billing. DB: Docker MySQL rootaroo-mysql-impl:3307 (rootaroo_test for tests, rootaroo_impl for the live check).

## Commits

- 475b030e checkout sweep (7.1)
- ee6105fc reconciliation runs and `--backfill` (7.2)
- b1db920c alerting and reconcile jobs (7.3)
- efb8a515 price notices and `--migrate-prices` (7.4)

## Gate results

| Check | Result |
|---|---|
| `npx jest` (unit) | 52 suites, 710 tests, all pass |
| `npm run type-check` | clean |
| `npm run lint` | 0 errors, 161 warnings (no-explicit-any in tests, same class as baseline) |
| `npm run test:int` | 23 suites, 139 tests, all pass on the final run |

Note: the first full `test:int` run had one failure inside `webhooks.int.test.ts` (test name not captured). The file passed 13/13 when re-run alone, and the whole suite passed 139/139 on a second full run. Treated as a timing flake; not reproduced.

## Live reconciliation (dev sandbox, rootaroo_impl, Stripe test mode)

Command: `npm run billing:bootstrap -- --mode test --backfill` (runs a `weekly` reconciliation).

Result: run `2161a970-4aad-4269-9cf3-bcb1f57e51f1`, status `succeeded`, one row written to `billing_reconciliation_runs`.

Counts: subscriptionsChecked 0, subscriptionsFixed 0, missingInStripe 0, ledgerUpserts 0, feesFilled 0, emailDriftFixed 0, checkoutRowsFixed 1, reviewItems 0.

The sandbox holds no subscriptions or invoices in the 35-day window, so the only effect was one stale `open`/`creating` checkout row being marked by the sweep. The planted-mismatch behaviour is covered by `reconcile.int.test.ts`.

## Boot log

`tsx src/index.ts` (PORT 3999, stopped after 40 s) logged every billing job:

- [Billing Sweep] every minute
- [Checkout Sweep] every 15 minutes
- [Reconcile] daily 03:30 UTC, weekly Sunday 04:00 UTC
- [Price Notices] daily 05:00 UTC

## Deviations from the plan

- Email-drift check in `reconcile.ts` is wrapped per customer in try/catch (warn and continue) and tolerates an empty Stripe response; the plan's version threw and failed the whole run on one bad customer (found by the cross-provider duplicate test).
- `runReconciliationLocked` filters the failed-run lookup by `livemode` as well as `kind`.
- `--migrate-prices` was added to the bootstrap in 7.4 (not 7.2) because it depends on `priceNotices.ts`; `--backfill` was added in 7.2.
- Commit trailer is the single `Co-Authored-By` line as instructed (no Claude-Session line).
