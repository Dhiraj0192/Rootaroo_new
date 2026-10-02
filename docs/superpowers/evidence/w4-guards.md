# Wave 4 gate results (entitlement and guards)

Commits: 4.1 `6a8e082c`, 4.2 `1d5e6a7a`, 4.3 `2ce4273a`, 4.4 `13c88930`, 4.5 `b170885b`.

| Check | Result |
|---|---|
| `npx jest` (unit) | PASS: 40 suites, 618 tests (W3: 34/497) |
| `npm run type-check` | PASS |
| `npm run lint` | PASS, 0 errors, 138 warnings (W3: 133; `no-explicit-any` in new tests) |
| Integration suites, run per suite against rootaroo_test (Docker MySQL 3307) right after each task | PASS: `entitlement.int` 4, `guards.int` 26 (every guarded route 402, unguarded routes 200, NO_HOUSEHOLD 403, grace), `seats.int` 2 (concurrent join: exactly one wins), `sockets.int` 2, `plans.int` 3 |
| `npm run test:int` single full run | NOT RE-RUN AFTER THE FINAL COMMIT: the Docker engine became unresponsive (docker CLI hangs, `com.docker.backend` at high CPU, sequelize-cli migrate against 3307 hangs). Orchestrator must restart Docker and re-run `cd server && npm run test:int` (expected 8 suites: harness 2, locks 1, models 5, plans 3, entitlement 4, guards 26, seats 2, sockets 2). Per the rules no other DB was used. |
| Billing coverage (`src/modules/billing`, unit only, 11 suites / 171 tests) | cache 93%, catalog 89%, config 85%, errors 100%, locks 96%, mode 100%, plans 100%, socketGate 100%, entitlement 67% (middleware/seat functions are covered by the int suites), bootstrap script 66% |
| Secret grep | prints nothing |
| Job files | Only `grocery-archive.ts`, `calendar-sync.ts`, `overdue-points.ts` changed (plus `calendar/service.ts` `notifyUpcomingEvents`); purge and other job files untouched |
| Manual dev check (`GET /api/v1/tasks` 402, `GET /api/v1/households` 200) | Not done by the agent (needs running server plus DB). Equivalent behaviour is asserted by `guards.int.test.ts`. Orchestrator spot-check pending. |

Deviations from plan:
- `entitlement.ts` already contains the 4.3 seat functions in the 4.2 commit (single file edited across tasks); 4.3 commit holds household service, dbRetry and tests.
- Services keep their existing try/catch around the emit; the emit line is now `void emitToHousehold(...)`.
- Calendar service test gets a default `isEntitledBatch` mock returning all ids so existing `notifyUpcomingEvents` tests still run.
- Full `jest` is slow on this machine (about 100-200 s cold, hangs if run twice concurrently); `--forceExit` was used once for a timing run, a normal run also exited cleanly.
