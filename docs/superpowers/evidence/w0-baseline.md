# Wave 0 baseline (pre-billing, branch feat/billing)

## Jest (server, unit)
Test Suites: 22 passed, 22 total. Tests: 422 passed, 422 total. No failing suites.
(Jest prints a "worker failed to exit gracefully" notice and console warnings from mailer/grocery tests; pre-existing.)

## TypeScript
`npm run type-check`: exit 0, 0 errors.

## ESLint
`npm run lint`: exit 0, 0 errors, 105 warnings (all `no-explicit-any` style warnings).
