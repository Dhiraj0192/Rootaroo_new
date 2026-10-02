# Wave 1 gate results (deep-link scheme rename)

| Check | Result |
|---|---|
| Task 1.1 commit | `36ce8012` refactor(app): rename deep-link scheme rootaru to rootaroo (single commit) |
| `npx jest` (unit) | PASS: 23 suites, 426 tests (Wave 0 was 425; +1 ICS branding test) |
| `npm run type-check` | PASS |
| `npm run lint` | PASS, 0 errors, 105 warnings (baseline) |
| `npm run test:int` | PASS: 1 suite, 2 tests (rootaroo_test, Docker MySQL 3307) |
| `git grep -niE "rootaru([^o]\|$)" -- . ':(exclude)docs/superpowers'` | prints nothing, exit 1 |

Note: a new EAS dev-client build is required before W9 device testing (scheme and storage keys changed; testers sign in once more).
