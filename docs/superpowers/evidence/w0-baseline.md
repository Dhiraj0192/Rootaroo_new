# Wave 0 baseline (pre-billing, branch feat/billing)

## Jest (server, unit)
Test Suites: 22 passed, 22 total. Tests: 422 passed, 422 total. No failing suites.
(Jest prints a "worker failed to exit gracefully" notice and console warnings from mailer/grocery tests; pre-existing.)

## TypeScript
`npm run type-check`: exit 0, 0 errors.

## ESLint
`npm run lint`: exit 0, 0 errors, 105 warnings (all `no-explicit-any` style warnings).

## Environment
- Redis: Docker container `rootaroo-redis` (redis:7, port 6379, restart unless-stopped). `node scripts/redis-ping.js` prints `redis: PONG`. Memurai via winget failed (installer exit 1603, needs elevation).
- Stripe CLI: `@stripe/cli` 1.53.0 installed globally via npm.
- MySQL: listening on 127.0.0.1:3306 (Windows mysqld). `root` with an empty password is rejected (ER_ACCESS_DENIED) and `server/.env` carries a stale `DB_SOCKET` (XAMPP path). Databases not yet created/migrated; see w0-prereqs.md.
