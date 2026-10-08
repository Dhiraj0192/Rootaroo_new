# Wave 0 gate results

| Check | Result |
|---|---|
| `npx jest` (unit) | PASS: 23 suites, 425 tests (baseline 22/422 plus scanSecrets). |
| `npm run type-check` | PASS, exit 0 |
| `npm run lint` | PASS, 0 errors, 105 warnings (baseline) |
| `npm run test:int` | PASS: 1 suite, 2 tests against `rootaroo_test` on the throwaway Docker MySQL (127.0.0.1:3307) via `server/.env.impl`, which the harness loads when present (DB_NAME still forced to `rootaroo_test`). `jose` is stubbed for int tests (ESM-only). |
| Databases `rootaroo_impl` / `rootaroo_test` migrated | YES, all migrations on both |
| `node scripts/redis-ping.js` | `redis: PONG` (Docker redis:7, container `rootaroo-redis`) |
| `stripe --version` | `stripe version 1.53.0` (npm `@stripe/cli`) |
| `stripe` SDK | 23.0.0 installed, contains `2026-09-30.endive` (22.x does not; plan and spec updated to 23.x) |
| `core.hooksPath` | `server/.husky/_` |
| Secret-scan probe | Blocked (`sk_test_Ab…`, exit 1, nothing committed) |
| `server/.env` | gitignored, not staged |
| Redis status | Recorded in `w0-baseline.md` |
