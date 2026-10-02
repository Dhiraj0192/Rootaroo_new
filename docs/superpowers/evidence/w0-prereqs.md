# Wave 0 gate results

| Check | Result |
|---|---|
| `npx jest` (unit) | PASS: 23 suites, 425 tests (baseline 22 suites / 422 tests plus the new scanSecrets suite, 3 tests). One earlier full run under machine load reported 2 suites failing to run (crypto, vault); both pass alone and in the clean rerun. |
| `npm run type-check` | PASS, exit 0 |
| `npm run lint` | PASS, 0 errors, 105 warnings (same as baseline) |
| `npm run test:int` | NOT RUN: blocked. MySQL rejects `root` with an empty password (ER_ACCESS_DENIED); `server/.env` also has a stale `DB_SOCKET` (XAMPP path), which must be unset or emptied on Windows. |
| Databases `rootaroo_impl` / `rootaroo_test` migrated | NO (same blocker) |
| `node scripts/redis-ping.js` | `redis: PONG` (Docker redis:7, container `rootaroo-redis`) |
| `stripe --version` | `stripe version 1.53.0` (npm `@stripe/cli`) |
| `stripe` SDK | 22.6.2 installed, but its pinned API version is `2026-08-26.dahlia`; `2026-09-30.endive` is absent from every 22.x release. It first appears in `stripe@23.0.0`. Decision needed from the orchestrator. |
| `core.hooksPath` | `server/.husky/_` |
| Secret-scan probe | Blocked (`sk_test_Ab…`, exit 1, nothing committed) |
| `server/.env` | gitignored, not staged |
| Redis status | Recorded in `w0-baseline.md` |
