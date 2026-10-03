# Wave 12 final verification (targeted)

Branch `feat/billing`. Only targeted runs (no full unit or integration suite). Integration tests ran against a `rootaroo_test`
database that was dropped and recreated empty immediately before, so migrations were applied from scratch by the harness
`globalSetup`. The connection settings came from the gitignored `server/.env.impl` (no values recorded here).

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Type check | `cd server && npx tsc --noEmit` | PASS, exit 0 |
| 2 | Lint | `cd server && npm run lint` | PASS, 0 errors, 179 warnings (all `no-explicit-any` style) |
| 3 | Server unit, billing only | `cd server && npx jest src/modules/billing` | PASS: 28 suites, 335 tests |
| 4 | Integration (each file alone) | `cd server && set -a && . ./.env.impl && set +a && timeout 1800 npm run test:int -- src/modules/billing/__int__/<file>.int.test.ts` | PASS, see below |
| 5 | Mobile | `cd mobile && npx jest src/shared/billing` | PASS: 5 suites, 68 passed, 1 skipped |
| 6 | Secret scan, branch diff | `git diff develop...HEAD -U0` filtered for `(sk\|rk)_(live\|test)_`, `whsec_`, `AKIA`, `GOCSPX`, `BEGIN ... PRIVATE KEY` | Only the known false positives: dummy PEM in `iap/__tests__/types.test.ts` and the marker check in `iap/config.ts` |
| 7 | Tracked env files | `git ls-files \| grep -E '(^\|/)\.env'` | Only `server/.env.example` and `mobile/.env.example` |
| 8 | Old scheme | `git grep -n rootaru` | No hits in code or app files. Hits remain only in `docs/superpowers/` (plan, spec, w1/w9 evidence) where the rename itself is described |

## Integration files (database `rootaroo_test`, one run per file)

| File (`src/modules/billing/__int__/`) | Tests | Result |
|---|---|---|
| `checkout.int.test.ts` | 18 | PASS |
| `webhooks.int.test.ts` | 13 | PASS |
| `entitlement.int.test.ts` | 4 | PASS |
| `guards.int.test.ts` | 26 | PASS |
| `ledger.int.test.ts` | 12 | PASS |
| `worker.int.test.ts` | 7 | PASS |
| `reconcile.int.test.ts` | 6 | PASS |
| `adminAuth.int.test.ts` | 5 | PASS |
| `adminSummary.int.test.ts` | 5 | PASS |
| `adminCohortRouting.int.test.ts` | 9 | PASS |
| `adminReview.int.test.ts` | 5 | PASS |

Total 110 tests in 11 suites, all passing; no failures, no code changes needed in this pass.

## Not run here

- Full unit/integration/coverage suites (deliberately skipped on a low-memory machine; earlier waves recorded full runs, see the index).
- Android bundle export, store IAP integration suites and real-device checks, owner-DB acceptance (Wave 12.3).
