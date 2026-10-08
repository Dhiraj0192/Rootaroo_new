# Billing evidence index

Evidence for the billing implementation plan (`../plans/2026-10-02-billing-implementation.md`) against the design
(`../specs/2026-10-02-billing-stripe-iap-design.md`). Documentation lives in [`docs/billing/`](../../billing/README.md).
No file here contains keys, signing secrets or tokenized URLs (the e2e harness redacts them).

| Wave | File | What it proves | Status |
|---|---|---|---|
| 0 | [`w0-baseline.md`](./w0-baseline.md) | Pre-billing baseline: unit test counts, environment findings | Recorded |
| 0 | [`w0-prereqs.md`](./w0-prereqs.md) | Gate: tests, type-check, lint, integration harness and secret scan against a throwaway MySQL | Pass |
| 1 | [`w1-rename.md`](./w1-rename.md) | Deep-link scheme renamed to `rootaroo` everywhere, no leftovers | Pass |
| 2 | [`w2-foundations.md`](./w2-foundations.md) | Config/startup checks, mode resolution, models and migrations, locks | Pass |
| 3 | [`w3-bootstrap.md`](./w3-bootstrap.md) | Stripe bootstrap against the dev sandbox is idempotent (two runs) | Pass |
| 3 | [`w3-catalog.md`](./w3-catalog.md) | Catalog, price sets and `GET /billing/plans` | Pass |
| 4 | [`w4-guards.md`](./w4-guards.md) | Entitlement, `requireEntitlement` (402) on guarded routes, seats, sockets, ICS | Pass |
| 5 | [`w5-checkout.md`](./w5-checkout.md) | Checkout, return page, sync, portal, plan change, routing | Pass |
| 6 | [`w6-webhooks.md`](./w6-webhooks.md) | Ledger, event handlers, raw-body receiver, worker and sweep, deletion hooks | Pass |
| 7 | [`w7-reconcile.md`](./w7-reconcile.md) | Reconciliation, sweeps, price notices, alerting | Pass |
| 8 | [`w8-staff-api.md`](./w8-staff-api.md) | Staff billing-admin API, key separation, audit, coverage thresholds | Pass |
| 9 | [`w9-mobile.md`](./w9-mobile.md) | Mobile billing screens, paywall, return handling, jest | Pass; needs a new dev build for the renamed scheme |
| 10 | [`w10-e2e.md`](./w10-e2e.md) | End-to-end scenarios E1 to E15 against the Stripe dev sandbox | Pass (E1 to E4 hosted Checkout recorded later) |
| 10 | [`e2e/E1.json`](./e2e/E1.json) to [`e2e/E15.json`](./e2e/E15.json) | Raw per-scenario snapshots (DB rows, Stripe objects, redacted) | Pass |
| 10 | [`e2e/PENDING-checkout.md`](./e2e/PENDING-checkout.md) | Setup notes for the four hosted-Checkout scenarios (E1 to E4), originally deferred | Historical; superseded by E1 to E4 evidence in `w10-e2e.md` |
| 11 | [`w11-iap.md`](./w11-iap.md) | Apple/Google IAP server and mobile code, unit and integration tests | Pass on code; real-device store checks are manual (see [`device-test-checklist.md`](../../billing/device-test-checklist.md)) |
| 12 | [`w12-final.md`](./w12-final.md) | Final targeted verification: tsc, lint, unit, integration subset, mobile jest, secret scan, `rootaru` grep | See file |

Not covered by automated evidence: store IAP on real devices, iOS manual checklist, and owner-DB acceptance (Wave 12.3).
