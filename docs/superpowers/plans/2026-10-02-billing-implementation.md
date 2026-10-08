# Rootaroo Billing (Stripe + IAP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a server-enforced hard paywall for Rootaroo households, paid through Stripe Checkout (Phase 1) with Apple/Google IAP scaffolding (Phases 2–3), with fully separated test/live data, a reconciled ledger, and a staff billing API, after renaming the deep-link scheme to `rootaroo` (Phase 0).

**Architecture:** A new server module `server/src/modules/billing/` owns all billing state. Stripe is the source of truth: a single function, `upsertSubscription`, fetches fresh Stripe state under a named lock and is the only writer of subscription rows. Webhooks are verified, persisted and acknowledged immediately, then processed by an in-process worker with a sweep job. Entitlement is computed from local rows (mode-matched, Redis-cached for 60 s) and enforced by `requireEntitlement` in every guarded router, by socket gates, ICS and job filters. The mobile app reads `/billing/status` into a Zustand store and swaps `MainTabs` for a paywall stack when blocked.

**Tech Stack:** Node 22, Express 4, TypeScript 5 (strict), Sequelize 6 + MySQL 8, ioredis, node-cron, Zod, winston, Jest 29 + ts-jest + supertest, `stripe@23.x` (API `2026-09-30.endive`), Stripe CLI; Expo SDK 54 / React Native 0.81 / Zustand 5 / axios / `expo-web-browser`; Phase 2–3: `@apple/app-store-server-library`, `@googleapis/androidpublisher`, `jose`.

**Spec:** `docs/superpowers/specs/2026-10-02-billing-stripe-iap-design.md` (v2). The spec is the source of truth; when this plan and the spec disagree, stop and ask the orchestrator. Section references like "§8.1" point into the spec.

## Global Constraints

- Stripe SDK: `stripe@23.x`; every client is `new Stripe(key, { apiVersion: '2026-09-30.endive' })`. Never use the global key pattern.
- Never pass `payment_method_types`. `allow_promotion_codes: false`. `automatic_tax` stays off. Prices are `tax_behavior: 'exclusive'`.
- Currency USD; all amounts are integer cents; all ledger amounts are positive (direction comes from `type`).
- Lookup keys: `rootaroo_hh{N}_month` / `rootaroo_hh{N}_year`, N = 5..10. Monthly = 899 + 199 × (N − 5); yearly = 7999 + 2388 × (N − 5). Launch `price_set` = `2026-10`.
- Seats: 5 included, minimum plan 5, hard cap 10 members for everyone; unsubscribed household `seatsAllowed = 5`; test cohort `seatsAllowed = 10`.
- Grace: `BILLING_GRACE_DAYS` (default 7) computed only in `upsertSubscription` from Stripe timestamps.
- Every Stripe Customer, Checkout Session and subscription (`subscription_data.metadata`) carries `metadata.env = BILLING_ENV_TAG` (`dev|staging|prod`).
- Mode: `resolveMode` = `'test'` when `NODE_ENV !== 'production'`, else cohort `test` → `'test'`, else `'live'`. Webhooks/reconciliation take the mode from the endpoint/job, never from the household. Redis keys always include the mode: `billing:ent:{mode}:{householdId}`.
- Every billing model sets `paranoid: false`; every billing lookup of `Household`/`User` passes `paranoid: false`.
- Named locks: `billing:checkout:{householdId}:{mode}` (60 s), `billing:sub:{subId}` (30 s), `billing:job:{name}:{mode}`.
- Responses: `{ success: true, data }`; errors only through `AppError` subclasses and the global `errorHandler`. Staff list endpoints: `{ success, data, nextCursor }`.
- Return scheme fixed server-side: `rootaroo://billing/<result>`.
- The mobile app never receives a Stripe key.
- **Secrets:** never write a real key/secret value into code, tests, docs, commits or logs. Reference env var names only. Test fixtures build fake key-shaped strings at runtime, e.g. `['sk', 'test', 'x'.repeat(24)].join('_')`, so the pre-commit scanner never sees a literal.
- **DB credentials:** implementers never guess. Ask the orchestrator; the orchestrator writes `server/.env`.
- **Expo:** before writing any Expo code read the v54 docs (`https://docs.expo.dev/versions/v54.0.0/`), as `mobile/AGENTS.md` requires.
- Where a step says "Verify at implementation time", open the named `docs.stripe.com/...md` page before writing that call, and adjust only the named detail.
- Commit trailer (every commit, exactly these two final lines):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
  ```

## Review Focus

The five uncovered input classes most likely to bite a real user, each pinned by a test in the owning task:

1. **The same webhook delivered twice at the same moment** (Stripe retries overlap): the second `INSERT` hits the unique key and must return `200`, never `500`, and the event is processed once. Test: `webhooks.int.test.ts` "concurrent duplicate deliveries both get 200 and one row" (Task 6.4).
2. **Malformed or oversized webhook bodies** (wrong content type, non-JSON, > 1 MB): must return `400`/`413` with no row written and no crash. Test: `webhooks.int.test.ts` "rejects wrong content-type / oversized body" (Task 6.4).
3. **A household that already has more members than the largest plan** (legacy dev households with 11+ members, or 8 members choosing a 6-seat plan): checkout and plan change return `409 SEATS_BELOW_MEMBERS` with `memberCount`, and the paywall stepper starts at `max(5, memberCount)` and explains when `memberCount > 10`. Tests: `checkout.test.ts` "rejects 11-member household" (Task 5.5) and `PaywallScreen.test.js` "explains over-cap households" (Task 9.4).
4. **`ADMIN_BILLING_API_KEY` set to the same value as `ADMIN_API_KEY`**: key separation silently breaks. Startup must refuse. Test: `config.test.ts` "refuses identical admin and billing keys" (Task 2.3).
5. **Redis unavailable** (outage or local dev without Redis): locks must fall back to MySQL `GET_LOCK`, entitlement must read the DB, and checkout must still be single-flight. Tests: `locks.test.ts` "falls back to MySQL when Redis is not ready" (Task 2.4) and `locks.int.test.ts` "MySQL lock excludes a concurrent holder" (Task 2.4).

---

## Execution model

- One implementer subagent per task, then a reviewer subagent. The orchestrator runs each **Wave gate** and does not start the next wave until every gate criterion holds.
- Implementers work from `E:\MyFiles\Projects\Rootaroo` on branch `feat/billing`. Shell examples are Git Bash; `cd server` / `cd mobile` are relative to the repo root.
- Unit tests: `cd server && npx jest <path>`. Integration tests (real MySQL `rootaroo_test`): `cd server && npm run test:int -- <path>`.
- Baseline failures recorded in Task 0.1 are not regressions; any *new* failure blocks the gate.
- When a step says "append to `<file>`" and the snippet starts with `import` lines, move those imports into the file's existing import block and merge duplicates; the rest of the snippet goes at the end of the file.

## File map

Server, new (`server/src/modules/billing/`):

| File | Responsibility | Task |
|---|---|---|
| `types.ts` | Shared billing types | 2.1 |
| `errors.ts` | 402/409/503/403 billing errors | 2.1 |
| `config.ts` | Env loading, startup guards, Stripe clients per mode | 2.3 |
| `mode.ts` | `resolveMode`, `modeFromLivemode`, `livemodeOf` | 2.3 |
| `locks.ts` | `withLock` (Redis `SET NX PX`, MySQL `GET_LOCK` fallback) | 2.4 |
| `cache.ts` | Fail-open Redis JSON cache + pub/sub helpers | 2.4 |
| `catalog.ts` | Formulas, lookup keys, catalog cache, `findPriceInSet` | 3.1 |
| `scripts/stripe-bootstrap.ts` | Idempotent catalog/portal/webhook setup, `--set-prices`, `--migrate-prices`, `--backfill` | 3.2, 7.4, 7.2 |
| `context.ts` | `loadCallerContext`, `requireAdminContext` | 3.3 |
| `plans.ts` | `getPlansForMode` | 3.3 |
| `routes.ts`, `controller.ts`, `validation.ts` | User-facing billing API | 3.3, 5.x |
| `entitlement.ts` | `computeEntitlement`, `getEntitlement`, `isEntitledBatch`, seats, middleware | 4.1–4.3 |
| `socketGate.ts` | Socket entitlement cache, `emitToHousehold` | 4.4 |
| `review.ts` | Review-queue items | 5.1 |
| `notify.ts` | Admin notifications and staff alerts | 5.1 |
| `duplicates.ts` | §8.6 duplicate resolution | 5.2 |
| `sync.ts` | `upsertSubscription` (only writer of subscription state) | 5.3 |
| `routing.ts` | Routing rules and client headers | 5.4 |
| `copy.ts` | `formatUsd`, auto-renew disclosure text | 5.5 |
| `checkout.ts` | Checkout create, sync, status | 5.5, 5.6 |
| `returnPage.ts` | Public return route | 5.6 |
| `portal.ts`, `plan.ts` | Portal sessions, plan changes | 5.7 |
| `ledger.ts` | Ledger writes and linking | 6.1 |
| `handlers.ts` | Event dispatch table (§8.5) | 6.2 |
| `worker.ts` | Event processing queue and sweep | 6.3 |
| `webhooks.ts`, `webhookRoutes.ts` | Raw-body receivers | 6.4 |
| `deletion.ts` | §5.11 / §8.7 hooks | 6.5 |
| `checkoutSweep.ts` | §10 checkout sweep | 7.1 |
| `reconcile.ts` | Daily/weekly/manual reconciliation | 7.2 |
| `alerts.ts` | Run/burst alerting | 7.3 |
| `priceNotices.ts` | §6.4 migrations and notices | 7.4 |
| `admin/*` | Staff billing API (§11) | 8.x |
| `providers/*` | Apple/Google scaffolding (§16) | 11.x |

Server, new elsewhere: `server/src/jobs/billing-{event-sweep,checkout-sweep,reconcile,price-notices}.ts`, 10 models in `server/src/database/models/`, 4 migrations, `server/src/shared/utils/dbRetry.ts`, `server/src/shared/middleware/uploads.ts`, `server/scripts/{scan-secrets,ensure-databases,redis-ping}.js`, `server/jest.int.config.js`, `server/src/test/**` (shared helpers), `server/e2e/billing/**`.

Mobile, new: `mobile/src/shared/api/billing.js`, `mobile/src/shared/store/billingStore.js`, `mobile/src/shared/billing/{pricing,purchase,legalLinks}.js`, `mobile/src/shared/hooks/useBillingLifecycle.js`, `mobile/src/screens/billing/{PaywallScreen,PaywallMemberScreen,SubscriptionScreen}.jsx`, `mobile/src/screens/billing/components/{GraceBanner,PlanPicker}.jsx`, `mobile/jest.config.js`, `mobile/jest.setup.js`.

## Shared test helpers (defined once, referenced by name everywhere)

| Export | File | Defined in |
|---|---|---|
| `resetDb()`, `closeIntResources()` | `server/src/test/int/db.ts` | Task 0.4 |
| `createUser(overrides?)`, `createHouseholdWithAdmin(opts?)`, `addMember(householdId, overrides?)`, `authHeaderFor(user)` | `server/src/test/factories.ts` | Task 0.4 |
| `fakeKey(prefix)`, `fakeWebhookSecret(label?)` | `server/src/test/billing/secrets.ts` | Task 2.3 |
| `testBillingConfig(overrides?)` | `server/src/test/billing/config.ts` | Task 2.3 |
| `makeStripeMock()`, `installStripeMock(mode?)`, type `StripeMock` | `server/src/test/billing/stripeMock.ts` | Task 3.1 |
| `stripeSubscription()`, `stripeInvoice()`, `stripeCheckoutSession()`, `stripeRefund()`, `stripeDispute()`, `stripePrice()`, `stripeEvent()`, `catalogPrices()` | `server/src/test/billing/fixtures.ts` | Task 3.1 (extended in 5.3, 6.1) |
| `createSubscriptionRow(householdId, overrides?)`, `createCustomerRow(householdId, overrides?)` | `server/src/test/billing/rows.ts` | Task 4.1 |
| `signedWebhook(event, secret)` | `server/src/test/billing/webhookSign.ts` | Task 6.4 |

---

## Wave 0: Prerequisites and environment

### Task 0.1: Toolchain, dependencies and baseline

**Files:**
- Modify: `server/package.json`, `server/package-lock.json`
- Create: `docs/superpowers/evidence/w0-baseline.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `stripe` 23.x in `server/node_modules`; Stripe CLI on PATH; a recorded baseline of pre-existing test/type/lint results.

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm ci
cd ../mobile && npm ci
```
Expected: both exit 0.

- [ ] **Step 2: Record the baseline**

```bash
cd server
npx jest 2>&1 | tail -n 25 > ../docs/superpowers/evidence/.w0-jest.txt
npm run type-check > ../docs/superpowers/evidence/.w0-tsc.txt 2>&1; echo "tsc exit $?" >> ../docs/superpowers/evidence/.w0-tsc.txt
npm run lint > ../docs/superpowers/evidence/.w0-lint.txt 2>&1; echo "lint exit $?" >> ../docs/superpowers/evidence/.w0-lint.txt
```
Write `docs/superpowers/evidence/w0-baseline.md` with three sections (Jest summary line: suites/tests passed/failed and names of failing suites; tsc exit code and error count; eslint error/warning counts), then delete the three `.w0-*.txt` scratch files. Every later gate compares against this file.

- [ ] **Step 3: Add the Stripe SDK**

```bash
cd server && npm install stripe@^22
node -e "console.log(require('stripe/package.json').version)"
grep -rl "2026-09-30.endive" node_modules/stripe/types | head -n 1
```
Expected: version prints `23.x.y`; grep prints a file path. If grep prints nothing, run `npm install stripe@23` (latest 23 minor) and retry; if still nothing, STOP and report to the orchestrator (the pinned API version must exist in the SDK types).

- [ ] **Step 4: Install and verify the Stripe CLI**

```bash
npm i -g @stripe/cli
stripe --version
```
Expected: a version string. If the npm package is unavailable on this machine, ask the orchestrator to install the CLI (scoop `stripe` bucket or the GitHub release zip) and re-run `stripe --version`. CLI auth is never done with a pasted key: every later CLI call passes `--api-key "$STRIPE_TEST_SECRET_KEY"` read from the environment the orchestrator prepares.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json docs/superpowers/evidence/w0-baseline.md
git commit -F - <<'MSG'
chore(billing): add stripe@22 and record pre-billing baseline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 0.2: Databases, Redis and `server/.env`

**Files:**
- Create: `server/scripts/ensure-databases.js`, `server/scripts/redis-ping.js`
- Modify: `docs/superpowers/evidence/w0-baseline.md` (append environment section)
- Orchestrator-only (never committed): `server/.env`

**Interfaces:**
- Consumes: DB credentials from the orchestrator.
- Produces: migrated `rootaroo_dev` and `rootaroo_test` databases; a documented Redis status.

- [ ] **Step 1: Ask for credentials and the `.env` file**

Send the orchestrator this request verbatim and wait:

> I need MySQL access for `rootaroo_dev` and `rootaroo_test`. Please write `server/.env` (gitignored) with: `NODE_ENV=development`, `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=rootaroo_dev`, `REDIS_HOST`, `REDIS_PORT`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SERVER_BASE_URL`, `BILLING_ENV_TAG=dev`, `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRETS` (may stay empty until Task 6.4), `BILLING_PUBLIC_BASE_URL`, `ADMIN_BILLING_API_KEY` (≥ 32 chars, different from `ADMIN_API_KEY`), `ADMIN_API_KEY`, `ADMIN_EMAIL`, `BILLING_GRACE_DAYS=7`. Tell me when it exists. I will not read or print secret values.

Then verify without printing values:
```bash
git check-ignore -q server/.env && echo "ignored OK"
node -e "require('dotenv').config({path:'server/.env'});for(const k of ['DB_HOST','DB_USER','DB_NAME','STRIPE_TEST_SECRET_KEY','BILLING_ENV_TAG'])console.log(k, process.env[k]?'set':'MISSING')"
```
Expected: `ignored OK` and every key `set`.

- [ ] **Step 2: Write `server/scripts/ensure-databases.js`**

```js
'use strict';
// Creates rootaroo_dev and rootaroo_test if missing, using server/.env credentials.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : {}),
  });
  for (const name of ['rootaroo_dev', 'rootaroo_test']) {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`database ${name}: ok`);
  }
  await conn.end();
}

main().catch((err) => {
  console.error(`ensure-databases failed: ${err.code || err.message}`);
  process.exit(1);
});
```

- [ ] **Step 3: Create and migrate both databases**

```bash
cd server
node scripts/ensure-databases.js
npm run db:migrate
NODE_ENV=test DB_NAME=rootaroo_test npx sequelize-cli db:migrate
```
Expected: two `ok` lines; both migrate runs end with no error.

- [ ] **Step 4: Write `server/scripts/redis-ping.js` and check Redis**

```js
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Redis = require('ioredis');

const client = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  lazyConnect: true,
});

client
  .connect()
  .then(() => client.ping())
  .then((r) => { console.log(`redis: ${r}`); return client.quit(); })
  .catch((err) => { console.log(`redis: UNAVAILABLE (${err.message})`); process.exit(2); });
```
Run `cd server && node scripts/redis-ping.js`. Expected `redis: PONG`.

If unavailable, record the fallback in the evidence file and tell the orchestrator: billing locks fall back to MySQL `GET_LOCK`; the entitlement cache is bypassed (DB reads); catalog cache busts are in-process only; the general rate limiter fails open; **auth routes fail closed (503)**, so W10 end-to-end needs Redis. Options for the orchestrator: Memurai Developer (Windows), `docker run -d -p 6379:6379 redis:7`, or WSL `redis-server`.

- [ ] **Step 5: Append the environment section and commit**

Append to `docs/superpowers/evidence/w0-baseline.md`: MySQL version (`SELECT VERSION()` via the mysql client or a one-line node script), both databases migrated (yes/no), Redis status and chosen fallback. No credentials.

```bash
git add server/scripts/ensure-databases.js server/scripts/redis-ping.js docs/superpowers/evidence/w0-baseline.md
git commit -F - <<'MSG'
chore(billing): database bootstrap and redis check scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 0.3: `.env.example` and the pre-commit secret scanner

**Files:**
- Modify: `server/.env.example`, `server/package.json` (`prepare` script)
- Create: `server/scripts/scan-secrets.js`, `server/.husky/pre-commit`, `server/src/shared/utils/__tests__/scanSecrets.test.ts`

**Interfaces:**
- Produces: `findSecrets(text: string): Array<{ line: number; match: string }>` (CommonJS, `server/scripts/scan-secrets.js`); a pre-commit hook that blocks staged secrets.

- [ ] **Step 1: Write the failing test**

`server/src/shared/utils/__tests__/scanSecrets.test.ts`:
```ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findSecrets, mask } = require('../../../../scripts/scan-secrets');

// Built at runtime so this file never contains a literal the scanner would flag.
const k = (...parts: string[]) => parts.join('_');

describe('scan-secrets', () => {
  it('flags secret, restricted and webhook keys with their line numbers', () => {
    const text = [
      'const a = 1;',
      `key = "${k('sk', 'live', 'A1b2C3d4E5f6G7')}"`,
      `rk = ${k('rk', 'test', 'Zz9Yy8Xx7Ww6')}`,
      `wh: ${k('whsec', 'Qq1Ww2Ee3Rr4Tt5')}`,
    ].join('\n');
    const found = findSecrets(text);
    expect(found.map((f: { line: number }) => f.line)).toEqual([2, 3, 4]);
  });

  it('ignores short or placeholder values', () => {
    expect(findSecrets(`${k('sk', 'test')}_… and ${k('whsec')}_… and ${k('sk', 'test', 'short')}`)).toEqual([]);
  });

  it('masks all but the prefix', () => {
    expect(mask(k('sk', 'test', 'ABCDEFGHIJKL'))).toBe('sk_test_AB…');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/shared/utils/__tests__/scanSecrets.test.ts`
Expected: FAIL, "Cannot find module '../../../../scripts/scan-secrets'".

- [ ] **Step 3: Write `server/scripts/scan-secrets.js`**

```js
'use strict';
// Blocks commits that contain Stripe secret/restricted keys or webhook secrets.
// Usage: node scripts/scan-secrets.js --staged   (run from the server/ directory or repo root)
const { execFileSync } = require('child_process');

const PATTERN = /(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/g;

function findSecrets(text) {
  const out = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    for (const m of lineText.matchAll(PATTERN)) out.push({ line: i + 1, match: m[0] });
  });
  return out;
}

function mask(s) {
  const prefix = s.startsWith('whsec_') ? 'whsec_' : s.slice(0, 8);
  return `${prefix}${s.slice(prefix.length, prefix.length + 2)}…`;
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function stagedContent(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function main() {
  let failed = false;
  for (const file of stagedFiles()) {
    if (/\.(png|jpe?g|gif|webp|pdf|zip|ttf|otf|woff2?|mp4|mov|lottie)$/i.test(file)) continue;
    for (const hit of findSecrets(stagedContent(file))) {
      failed = true;
      console.error(`secret-scan: ${file}:${hit.line} looks like a secret (${mask(hit.match)})`);
    }
  }
  if (failed) {
    console.error('secret-scan: commit blocked. Move the value to server/.env and reference the env var name.');
    process.exit(1);
  }
}

module.exports = { findSecrets, mask, PATTERN };
if (require.main === module && process.argv.includes('--staged')) main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest src/shared/utils/__tests__/scanSecrets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire Husky (server lives in a subdirectory of the git root)**

In `server/package.json` change `"prepare": "husky"` to:
```json
"prepare": "cd .. && husky server/.husky"
```
Create `server/.husky/pre-commit`:
```sh
node server/scripts/scan-secrets.js --staged
```
Then:
```bash
cd server && npm run prepare
git config core.hooksPath
```
Expected: `server/.husky/_`. Read Husky 9's "project not in git root" note (`https://typicode.github.io/husky/how-to.html`) if the path differs.

- [ ] **Step 6: Prove the hook blocks a secret**

```bash
node -e "require('fs').writeFileSync('server/tmp-secret-probe.txt', ['sk','test','Abcdefghijkl12'].join('_'))"
git add server/tmp-secret-probe.txt
git commit -m "probe" ; echo "exit=$?"
git reset -q server/tmp-secret-probe.txt && rm server/tmp-secret-probe.txt
```
Expected: `secret-scan: server/tmp-secret-probe.txt:1 ...` and `exit=1`; nothing committed.

- [ ] **Step 7: Update `server/.env.example`** (append, empty values only)

```
# ── Billing (Stripe) ──
# dev | staging | prod. Production must be prod.
BILLING_ENV_TAG=
# Test sandbox key for this environment (sk_test_… or rk_test_…). Empty disables test mode.
STRIPE_TEST_SECRET_KEY=
# Comma-separated whsec_… list; two values during a rotation.
STRIPE_TEST_WEBHOOK_SECRETS=
# Production only. Setting these outside production refuses startup.
STRIPE_LIVE_SECRET_KEY=
STRIPE_LIVE_WEBHOOK_SECRETS=
# Optional bootstrap-only keys (products, prices, portal, webhook endpoints). Fall back to the runtime keys.
STRIPE_BOOTSTRAP_TEST_KEY=
STRIPE_BOOTSTRAP_LIVE_KEY=
# https origin used to build Checkout/portal return URLs (defaults to SERVER_BASE_URL outside production)
BILLING_PUBLIC_BASE_URL=
# Staff billing API key (>= 32 chars, must differ from ADMIN_API_KEY) and optional CIDR allowlist
ADMIN_BILLING_API_KEY=
ADMIN_BILLING_IP_ALLOWLIST=
BILLING_GRACE_DAYS=
# rootaroo_app_checkout_<8 lowercase letters>; leave empty to use the built-in constant
STRIPE_INTEGRATION_ID=

# ── Apple App Store (Phase 2) ──
APPLE_IAP_ISSUER_ID=
APPLE_IAP_KEY_ID=
APPLE_IAP_PRIVATE_KEY=
APPLE_IAP_APP_APPLE_ID=
# ── Google Play (Phase 3) ──
GOOGLE_PLAY_PACKAGE_NAME=
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
GOOGLE_RTDN_AUDIENCE=
GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL=
```

- [ ] **Step 8: Commit**

```bash
git add server/scripts/scan-secrets.js server/.husky/pre-commit server/package.json server/.env.example server/src/shared/utils/__tests__/scanSecrets.test.ts
git commit -F - <<'MSG'
chore(security): pre-commit secret scanner and billing env template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 0.4: Integration-test harness against real MySQL

**Files:**
- Create: `server/jest.int.config.js`, `server/src/test/int/env.ts`, `server/src/test/int/globalSetup.ts`, `server/src/test/int/db.ts`, `server/src/test/factories.ts`, `server/src/test/int/__int__/harness.int.test.ts`
- Modify: `server/jest.config.js`, `server/package.json` (`test:int` script, `socket.io-client` dev dependency)

**Interfaces:**
- Produces:
  - `resetDb(): Promise<void>` truncates every table except `sequelize_meta`.
  - `closeIntResources(): Promise<void>` closes Sequelize and Redis.
  - `createUser(overrides?: Partial<{ email: string; displayName: string; role: 'admin'|'member'|'child' }>): Promise<User>`
  - `createHouseholdWithAdmin(opts?: { name?: string; cohort?: 'live'|'test'; admin?: User }): Promise<{ household: Household; admin: User }>`
  - `addMember(householdId: string, overrides?: { role?: 'member'|'child'; user?: User }): Promise<User>`
  - `authHeaderFor(user: User): { Authorization: string }`

- [ ] **Step 1: Write the harness smoke test (fails: no config yet)**

`server/src/test/int/__int__/harness.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations, HouseholdMember } from '../../../database/models';
import { resetDb, closeIntResources } from '../db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('integration harness', () => {
  it('uses the _test database', () => {
    expect(process.env.DB_NAME).toMatch(/_test$/);
  });

  it('creates a household with members and authenticates', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await addMember(household.id);
    expect(await HouseholdMember.count({ where: { householdId: household.id } })).toBe(2);
    const res = await request(app).get('/api/v1/households').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe(household.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest -c jest.int.config.js src/test/int/__int__/harness.int.test.ts`
Expected: FAIL, "Can't find a root directory" / config file not found.

- [ ] **Step 3: Write the harness**

`server/jest.int.config.js`:
```js
/** Integration tests: real MySQL (rootaroo_test). Run with `npm run test:int`. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__int__/**/*.int.test.ts'],
  setupFiles: ['<rootDir>/src/test/int/env.ts'],
  globalSetup: '<rootDir>/src/test/int/globalSetup.ts',
  testTimeout: 30000,
};
```

`server/jest.config.js`: add `testPathIgnorePatterns: ['/node_modules/', '/__int__/'],` after `testMatch`.

`server/src/test/int/env.ts`:
```ts
// Runs before any module import in every integration test file.
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'rootaroo_test';
if (!process.env.DB_NAME.endsWith('_test')) {
  throw new Error(`Refusing to run integration tests against ${process.env.DB_NAME}`);
}
process.env.BILLING_ENV_TAG = process.env.BILLING_ENV_TAG || 'dev';
// Integration tests never call Stripe: tests install a mock client (installStripeMock).
process.env.STRIPE_TEST_SECRET_KEY = ['sk', 'test', 'integrationharness0000'].join('_');
process.env.STRIPE_TEST_WEBHOOK_SECRETS = ['whsec', 'integrationharness0000'].join('_');
delete process.env.STRIPE_LIVE_SECRET_KEY;
delete process.env.STRIPE_LIVE_WEBHOOK_SECRETS;
process.env.ADMIN_API_KEY = 'int-admin-key-0123456789abcdef0123456789';
process.env.ADMIN_BILLING_API_KEY = 'int-billing-key-0123456789abcdef01234567';
```
Note: `dotenv.config()` in `config/env.ts` never overrides variables that are already set, so these values win over `server/.env`.

`server/src/test/int/globalSetup.ts`:
```ts
import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup(): Promise<void> {
  const dbName = process.env.DB_NAME_TEST || 'rootaroo_test';
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to migrate ${dbName}`);
  execSync('npx sequelize-cli db:migrate', {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, NODE_ENV: 'test', DB_NAME: dbName },
    stdio: 'inherit',
  });
}
```

`server/src/test/int/db.ts`:
```ts
import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';
import redis from '../../config/redis';

export async function resetDb(): Promise<void> {
  const rows = await sequelize.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'sequelize_meta' AND table_type = 'BASE TABLE'",
    { type: QueryTypes.SELECT },
  );
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const { name } of rows) await sequelize.query(`TRUNCATE TABLE \`${name}\``);
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  if (redis.status === 'ready') {
    const keys = await redis.keys('billing:*');
    if (keys.length) await redis.del(...keys);
  }
}

export async function closeIntResources(): Promise<void> {
  await sequelize.close();
  redis.disconnect();
}
```
Note: routing-rule seed rows from migrations are truncated by `resetDb`; tests that need rules insert them (Task 5.4 provides `seedDefaultRoutingRules()`).

`server/src/test/factories.ts`:
```ts
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { User, Household, HouseholdMember } from '../database/models';

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function createUser(
  overrides: Partial<{ email: string; displayName: string; role: 'admin' | 'member' | 'child' }> = {},
): Promise<User> {
  const n = next();
  return User.create({
    id: uuidv4(),
    email: overrides.email ?? `user-${n}@example.test`,
    passwordHash: 'not-a-real-hash',
    displayName: overrides.displayName ?? `User ${n}`,
    role: overrides.role ?? 'member',
    isVerified: true,
  });
}

export async function createHouseholdWithAdmin(
  opts: { name?: string; cohort?: 'live' | 'test'; admin?: User } = {},
): Promise<{ household: Household; admin: User }> {
  const admin = opts.admin ?? (await createUser({ role: 'admin' }));
  const household = await Household.create({
    id: uuidv4(),
    name: opts.name ?? 'Test Family',
    inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
    ...(opts.cohort ? { billingCohort: opts.cohort } : {}),
  });
  await HouseholdMember.create({ id: uuidv4(), householdId: household.id, userId: admin.id, role: 'admin', joinedAt: new Date() });
  return { household, admin };
}

export async function addMember(
  householdId: string,
  overrides: { role?: 'member' | 'child'; user?: User } = {},
): Promise<User> {
  const user = overrides.user ?? (await createUser({ role: overrides.role ?? 'member' }));
  await HouseholdMember.create({ id: uuidv4(), householdId, userId: user.id, role: overrides.role ?? 'member', joinedAt: new Date() });
  return user;
}

export function authHeaderFor(user: User): { Authorization: string } {
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, env.jwt.accessSecret, { expiresIn: '15m' });
  return { Authorization: `Bearer ${token}` };
}
```
(`billingCohort` is added to `Household` in Task 2.5; until then `opts.cohort` is never passed.)

`server/package.json` scripts: add `"test:int": "jest -c jest.int.config.js --runInBand"`. Dev dependency: `cd server && npm install -D socket.io-client@^4.8` (used by Task 4.4).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/test/int/__int__/harness.int.test.ts`
Expected: PASS (2 tests). Also `cd server && npx jest` still matches the baseline (no `__int__` files picked up).

- [ ] **Step 5: Commit**

```bash
git add server/jest.int.config.js server/jest.config.js server/package.json server/package-lock.json server/src/test
git commit -F - <<'MSG'
test(infra): integration test harness against real MySQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 0 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && node scripts/redis-ping.js; stripe --version
git config core.hooksPath
```
Acceptance:
- Unit suite result equals the Task 0.1 baseline plus the new `scanSecrets` suite passing.
- `npm run test:int` passes; `rootaroo_dev` and `rootaroo_test` are migrated.
- `stripe --version` prints; `stripe` 23.x installed with `2026-09-30.endive` in its types.
- `core.hooksPath` is `server/.husky/_` and the Task 0.3 Step 6 probe was blocked.
- `server/.env` exists, is gitignored and is not staged (`git status --porcelain server/.env` prints nothing).
- Redis status recorded in `docs/superpowers/evidence/w0-baseline.md`.

---

## Wave 1: Phase 0, deep-link scheme rename (§2)

### Task 1.1: Rename `rootaru` to `rootaroo` everywhere

**Files:**
- Modify: `mobile/app.json:5`, `mobile/src/screens/HouseholdSetupScreen.jsx:14-15`, `mobile/src/screens/HouseholdSettingsScreen.jsx:81`, `mobile/src/screens/InviteMembersScreen.jsx:41`, `mobile/src/shared/store/authPersist.js:4-7`, `mobile/src/shared/store/signupProgress.js:3`, `mobile/src/shared/store/dailyWelcomePersist.js:7`, `server/src/modules/household/service.ts:149`, `server/src/modules/household/__tests__/household.service.test.ts:104`, `server/src/modules/calendar/service.ts:367,374`, `server/src/modules/calendar/controller.ts:62`, `server/restart-dev.sh:8`, `docs/auth-documentation.html:597,619,1696`
- Test: `server/src/modules/household/__tests__/household.service.test.ts`, `server/src/modules/calendar/__tests__/calendar.service.test.ts`

**Interfaces:** none. This task is a single revertable commit (§2).

- [ ] **Step 1: Update the tests first**

In `household.service.test.ts` line 104 change the expectation to:
```ts
      expect(result.shareLink).toContain('rootaroo://join?code=');
```
Append to `calendar.service.test.ts` (inside its top-level describe, reusing that file's existing `CalendarEvent`/`HouseholdMember` mocks; if its model mock lacks `CalendarEvent.findAll`, add `findAll: jest.fn()` to that mock object):
```ts
  describe('exportHouseholdIcs branding', () => {
    it('uses the rootaroo UID domain and product id', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'hh-1' });
      (models.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
        { id: 'ev-1', eventDate: '2026-10-05', startTime: '09:00:00', endTime: null, title: 'Dentist', description: null, isRecurring: false, recurrenceRule: null },
      ]);
      const ics = await exportHouseholdIcs('user-1');
      expect(ics).toContain('UID:ev-1@rootaroo');
      expect(ics).toContain('PRODID:-//Rootaroo//Family Calendar//EN');
    });
  });
```
(Import `exportHouseholdIcs` from `../service` alongside the file's existing imports.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx jest src/modules/household/__tests__/household.service.test.ts src/modules/calendar/__tests__/calendar.service.test.ts -t "share link|branding"`
Expected: FAIL on `rootaroo://` and on `@rootaroo` / `Rootaroo` PRODID.

- [ ] **Step 3: Make every change**

- `mobile/app.json`: `"scheme": "rootaroo",`
- `HouseholdSetupScreen.jsx`: comment line → `// Invite Members (rootaroo://join?code=XXXX) — see app.json's "scheme".`; `const JOIN_LINK_RE = /^rootaroo:\/\/join\?code=([A-Za-z0-9]+)$/i;`
- `HouseholdSettingsScreen.jsx:81` and `InviteMembersScreen.jsx:41`: `` `rootaroo://join?code=${inviteCode}` ``
- `authPersist.js` keys: `'rootaroo_access_token'`, `'rootaroo_refresh_token'`, `'rootaroo_user'`, `'rootaroo_household_id'` (dev testers are signed out once, accepted by §2).
- `dailyWelcomePersist.js`: `const KEY_PREFIX = 'rootaroo_daily_welcome_';`
- `signupProgress.js`: `const KEY = 'rootaroo_signup_progress';`
- `household/service.ts:149`: `` shareLink: `rootaroo://join?code=${code}`, ``
- `calendar/service.ts`: `'PRODID:-//Rootaroo//Family Calendar//EN',` and `` const uid = `${ev.id}@rootaroo`; ``
- `calendar/controller.ts:62`: `'attachment; filename="rootaroo-calendar.ics"'`
- `restart-dev.sh:8`: `pkill -f 'rootaroo/server.*tsx src/index.ts' 2>/dev/null || true`
- `docs/auth-documentation.html`: `sed -i -E 's/rootaru([^o]|$)/rootaroo\1/g' docs/auth-documentation.html`

- [ ] **Step 4: Verify**

```bash
cd server && npx jest src/modules/household src/modules/calendar
cd .. && git grep -niE "rootaru([^o]|$)" -- . ':(exclude)docs/superpowers' ; echo "grep exit=$?"
```
Expected: tests PASS; grep prints nothing and `grep exit=1`. (The spec and plan under `docs/superpowers/` quote the old spelling on purpose and are excluded; the match is case-insensitive so `Rootaru` is caught too.)

- [ ] **Step 5: Commit (single, revertable)**

```bash
git add -A mobile/app.json mobile/src server/src/modules/household server/src/modules/calendar server/restart-dev.sh docs/auth-documentation.html
git commit -F - <<'MSG'
refactor(app): rename deep-link scheme rootaru to rootaroo

Phase 0 of the billing spec. Storage keys move to rootaroo_* (dev
testers sign in once more); ICS UIDs move to @rootaroo. Needs a new
EAS dev-client build.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 1 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd .. && git grep -niE "rootaru([^o]|$)" -- . ':(exclude)docs/superpowers'
```
Acceptance: unit/int/type-check/lint at baseline or better; the grep prints nothing; the rename is exactly one commit (`git log --oneline -1` shows the refactor). The orchestrator notes in the evidence file that a new EAS dev-client build is required before W9 device testing.

---
## Wave 2: Billing foundations (§4, §5)

### Task 2.1: Error details, billing types and billing errors

**Files:**
- Modify: `server/src/shared/utils/errors.ts`, `server/src/shared/middleware/errorHandler.ts`
- Create: `server/src/modules/billing/types.ts`, `server/src/modules/billing/errors.ts`
- Test: `server/src/shared/middleware/__tests__/errorHandler.test.ts`, `server/src/modules/billing/__tests__/errors.test.ts`

**Interfaces:**
- Produces:
  - `AppError(statusCode: number, message: string, code?: string, details?: Record<string, unknown>)`; `errorHandler` spreads `details` into the JSON body without letting them override `success`, `error`, `message`, `code`.
  - `types.ts`: `BillingMode = 'test'|'live'`, `BillingCohort = 'live'|'test'`, `BillingInterval = 'month'|'year'`, `BillingProvider = 'stripe'|'apple'|'google'`, `SubscriptionStatus`, `ALLOWED_STATUSES`, `EntitlementReason`, `EntitlementSubscription`, `Entitlement`, `PurchaseMethod`, `ClientPlatform`, `ClientContext`, `CheckoutState`, `PendingCheckout`.
  - `errors.ts`: `PaymentRequiredError(code: 'SUBSCRIPTION_REQUIRED'|'SEAT_LIMIT', message, details?)` (402), `BillingConflictError(code: BillingConflictCode, message, details?)` (409), `BillingUnavailableError(message?)` (503 `BILLING_MODE_UNAVAILABLE`), `NoHouseholdError()` (403 `NO_HOUSEHOLD`), `LockBusyError(name)` (409 `LOCK_BUSY`), type `BillingConflictCode`.

- [ ] **Step 1: Write the failing tests**

`server/src/shared/middleware/__tests__/errorHandler.test.ts`:
```ts
import { errorHandler } from '../errorHandler';
import { AppError } from '../../utils/errors';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('errorHandler', () => {
  it('merges AppError details into the body', () => {
    const res = mockRes();
    errorHandler(new AppError(402, 'Pay up', 'SUBSCRIPTION_REQUIRED', { reason: 'subscription_required', isAdmin: true }), {} as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      reason: 'subscription_required', isAdmin: true,
      success: false, error: 'Pay up', message: 'Pay up', code: 'SUBSCRIPTION_REQUIRED',
    });
  });

  it('never lets details override the core fields', () => {
    const res = mockRes();
    errorHandler(new AppError(409, 'No', 'X', { success: true, code: 'HACK' }), {} as any, res, jest.fn());
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'X' });
  });

  it('keeps the old shape when there are no details', () => {
    const res = mockRes();
    errorHandler(new AppError(404, 'Gone', 'NOT_FOUND'), {} as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Gone', message: 'Gone', code: 'NOT_FOUND' });
  });
});
```

`server/src/modules/billing/__tests__/errors.test.ts`:
```ts
import { PaymentRequiredError, BillingConflictError, BillingUnavailableError, NoHouseholdError, LockBusyError } from '../errors';

describe('billing errors', () => {
  it('maps to the documented status codes and codes', () => {
    expect(new PaymentRequiredError('SEAT_LIMIT', 'full', { seatsAllowed: 5 })).toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT', details: { seatsAllowed: 5 } });
    expect(new BillingConflictError('ALREADY_SUBSCRIBED', 'dup')).toMatchObject({ statusCode: 409, code: 'ALREADY_SUBSCRIBED' });
    expect(new BillingUnavailableError()).toMatchObject({ statusCode: 503, code: 'BILLING_MODE_UNAVAILABLE' });
    expect(new NoHouseholdError()).toMatchObject({ statusCode: 403, code: 'NO_HOUSEHOLD' });
    expect(new LockBusyError('billing:x')).toMatchObject({ statusCode: 409, code: 'LOCK_BUSY' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/shared/middleware/__tests__/errorHandler.test.ts src/modules/billing/__tests__/errors.test.ts`
Expected: FAIL (details not merged; `../errors` missing).

- [ ] **Step 3: Implement**

`server/src/shared/utils/errors.ts`, replace the `AppError` class:
```ts
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
    /** Extra machine-readable fields merged into the JSON error body (e.g. 402 reason/isAdmin). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}
```

`server/src/shared/middleware/errorHandler.ts`, replace the AppError branch body:
```ts
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ...(err.details ?? {}),
      success: false,
      error: err.message,
      message: err.message,
      code: err.code,
    });
    return;
  }
```

`server/src/modules/billing/types.ts`:
```ts
export type BillingMode = 'test' | 'live';
export type BillingCohort = 'live' | 'test';
export type BillingInterval = 'month' | 'year';
export type BillingProvider = 'stripe' | 'apple' | 'google';
export type SubscriptionStatus =
  | 'incomplete' | 'incomplete_expired' | 'trialing' | 'active'
  | 'past_due' | 'unpaid' | 'canceled' | 'paused';

/** Statuses that can grant access (past_due only while in grace). */
export const ALLOWED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export type EntitlementReason = 'test_cohort' | 'active' | 'grace' | 'subscription_required';

export interface EntitlementSubscription {
  id: string;
  provider: BillingProvider;
  status: SubscriptionStatus;
  seats: number;
  interval: BillingInterval;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Entitlement {
  allowed: boolean;
  reason: EntitlementReason;
  mode: BillingMode;
  subscription: EntitlementSubscription | null;
  graceUntil: string | null;
  seatsAllowed: number;
}

export type PurchaseMethod = 'stripe_checkout' | 'apple_iap' | 'google_play' | 'none';
export type ClientPlatform = 'ios' | 'android' | 'web';
export interface ClientContext { platform: ClientPlatform; country: string }

export type CheckoutState = 'open' | 'processing' | 'complete' | 'expired';
export interface PendingCheckout { sessionId: string; state: CheckoutState }
```

`server/src/modules/billing/errors.ts`:
```ts
import { AppError } from '../../shared/utils/errors';

export type BillingConflictCode =
  | 'ALREADY_SUBSCRIBED'
  | 'PAYMENT_ISSUE'
  | 'SEATS_BELOW_MEMBERS'
  | 'PURCHASE_METHOD_MISMATCH'
  | 'NO_ACTIVE_SUBSCRIPTION'
  | 'COHORT_CHANGE_BLOCKED';

export class PaymentRequiredError extends AppError {
  constructor(code: 'SUBSCRIPTION_REQUIRED' | 'SEAT_LIMIT', message: string, details: Record<string, unknown> = {}) {
    super(402, message, code, details);
  }
}

export class BillingConflictError extends AppError {
  constructor(code: BillingConflictCode, message: string, details: Record<string, unknown> = {}) {
    super(409, message, code, details);
  }
}

export class BillingUnavailableError extends AppError {
  constructor(message = 'Purchasing is not available right now') {
    super(503, message, 'BILLING_MODE_UNAVAILABLE');
  }
}

export class NoHouseholdError extends AppError {
  constructor() {
    super(403, 'You must belong to a household to do this', 'NO_HOUSEHOLD');
  }
}

export class LockBusyError extends AppError {
  constructor(public lockName: string) {
    super(409, 'Another billing operation is in progress. Try again in a moment.', 'LOCK_BUSY');
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/shared/middleware/__tests__/errorHandler.test.ts src/modules/billing/__tests__/errors.test.ts && npm run type-check`
Expected: PASS; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/shared/utils/errors.ts server/src/shared/middleware/errorHandler.ts server/src/shared/middleware/__tests__/errorHandler.test.ts server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): error details in responses, billing types and errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 2.2: Logger secret redaction (§4.2)

**Files:**
- Modify: `server/src/shared/utils/logger.ts`
- Test: `server/src/shared/utils/__tests__/logger.test.ts`

**Interfaces:**
- Produces: `SECRET_PATTERN: RegExp` (global), `redactSecrets(value: string): string`, `deepRedact(value: unknown, depth?: number): unknown`, `redactFormat` (a `winston.Logform.FormatWrap`).

- [ ] **Step 1: Write the failing test**

```ts
import { redactSecrets, deepRedact, redactFormat } from '../logger';

const k = (...p: string[]) => p.join('_');
const SK = k('sk', 'live', 'Abcdef123456');
const RK = k('rk', 'test', 'Zyxw98765432');
const WH = k('whsec', 'Qwerty123456789');

describe('logger redaction', () => {
  it('redacts every key shape in a string', () => {
    expect(redactSecrets(`a ${SK} b ${RK} c ${WH}`)).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });

  it('redacts nested objects, arrays and error stacks', () => {
    const err = new Error(`boom ${SK}`);
    const out = deepRedact({ a: [RK], b: { c: WH }, err }) as any;
    expect(JSON.stringify(out)).not.toMatch(/sk_live_A|rk_test_Z|whsec_Q/);
    expect(out.err.message).toBe('boom [REDACTED]');
  });

  it('redacts the winston info object including message, stack and meta', () => {
    const info: any = { level: 'error', message: `x ${SK}`, stack: `at ${WH}`, meta: { key: RK } };
    const out: any = redactFormat().transform(info, {});
    expect(out.message).toBe('x [REDACTED]');
    expect(out.stack).toBe('at [REDACTED]');
    expect(out.meta.key).toBe('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/shared/utils/__tests__/logger.test.ts`
Expected: FAIL, `redactSecrets` is not exported.

- [ ] **Step 3: Implement**

Replace `server/src/shared/utils/logger.ts` with:
```ts
import winston from 'winston';
import { env } from '../../config/env';

/** Stripe secret/restricted keys and webhook signing secrets (spec §4.2). */
export const SECRET_PATTERN = /(sk|rk)_(test|live)_\w+|whsec_\w+/g;

export function redactSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, '[REDACTED]');
}

export function deepRedact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactSecrets(value.stack) : undefined;
    return copy;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = deepRedact(v, depth + 1);
  return out;
}

export const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    (info as Record<string, unknown>)[key] = deepRedact((info as Record<string, unknown>)[key]);
  }
  const splat = Symbol.for('splat');
  const rec = info as unknown as Record<symbol, unknown>;
  if (Array.isArray(rec[splat])) rec[splat] = (rec[splat] as unknown[]).map((v) => deepRedact(v));
  return info;
});

const logger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    env.nodeEnv === 'development'
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            return `${timestamp} [${level}]: ${message}${stack ? '\n' + stack : ''}`;
          })
        )
      : winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/shared/utils/__tests__/logger.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/shared/utils/logger.ts server/src/shared/utils/__tests__/logger.test.ts
git commit -F - <<'MSG'
feat(billing): redact Stripe keys and webhook secrets from logs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 2.3: Billing config, startup guards, Stripe clients and mode resolution (§4.1–4.3)

**Files:**
- Create: `server/src/modules/billing/config.ts`, `server/src/modules/billing/mode.ts`, `server/src/test/billing/secrets.ts`, `server/src/test/billing/config.ts`
- Modify: `server/src/index.ts` (startup call)
- Test: `server/src/modules/billing/__tests__/config.test.ts`, `server/src/modules/billing/__tests__/mode.test.ts`

**Interfaces:**
- Consumes: `BillingMode`, `BillingCohort` (Task 2.1); `BillingUnavailableError` (Task 2.1).
- Produces:
  - `STRIPE_API_VERSION = '2026-09-30.endive'`, `DEFAULT_INTEGRATION_ID = 'rootaroo_app_checkout_qhzmvtkd'`
  - `type EnvTag = 'dev'|'staging'|'prod'`; `interface ModeConfig { secretKey: string; webhookSecrets: string[] }`
  - `interface BillingConfig { nodeEnv: string; envTag: EnvTag; graceDays: number; publicBaseUrl: string; integrationId: string; adminKey: string; adminIpAllowlist: string[]; modes: Record<BillingMode, ModeConfig | null>; warnings: string[] }`
  - `class BillingConfigError extends Error`
  - `loadBillingConfig(src: NodeJS.ProcessEnv): BillingConfig` (pure; throws `BillingConfigError`)
  - `getBillingConfig(): BillingConfig`, `isModeAvailable(mode): boolean`, `getStripe(mode): Stripe`, `assertBillingConfigAtStartup(): void`
  - test seams: `__setBillingConfigForTests(cfg: BillingConfig | null): void`, `__setStripeForTests(mode: BillingMode, client: unknown | null): void`
  - `mode.ts`: `resolveMode(household: { billingCohort: BillingCohort }, nodeEnv?: string): BillingMode`, `modeFromLivemode(livemode: boolean): BillingMode`, `livemodeOf(mode: BillingMode): boolean`
  - test helpers: `fakeKey(prefix: 'sk_test'|'rk_test'|'sk_live'|'rk_live'): string`, `fakeWebhookSecret(label?: string): string`, `testBillingConfig(overrides?: Partial<BillingConfig>): BillingConfig`

- [ ] **Step 1: Write the test helpers**

`server/src/test/billing/secrets.ts`:
```ts
// Fake key-shaped values are assembled at runtime so no literal ever reaches git
// (the pre-commit scanner flags literals, see scripts/scan-secrets.js).
export function fakeKey(prefix: 'sk_test' | 'rk_test' | 'sk_live' | 'rk_live'): string {
  return [prefix, `Fake${'x'.repeat(20)}`].join('_');
}

export function fakeWebhookSecret(label = 'unit'): string {
  return ['whsec', `${label}Secret0123456789`].join('_');
}
```

`server/src/test/billing/config.ts`:
```ts
import { BillingConfig, DEFAULT_INTEGRATION_ID } from '../../modules/billing/config';
import { fakeKey, fakeWebhookSecret } from './secrets';

export function testBillingConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    nodeEnv: 'test',
    envTag: 'dev',
    graceDays: 7,
    publicBaseUrl: 'https://api.example.test',
    integrationId: DEFAULT_INTEGRATION_ID,
    adminKey: 'b'.repeat(40),
    adminIpAllowlist: [],
    modes: { test: { secretKey: fakeKey('sk_test'), webhookSecrets: [fakeWebhookSecret()] }, live: null },
    warnings: [],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`server/src/modules/billing/__tests__/config.test.ts`:
```ts
jest.mock('stripe', () => jest.fn().mockImplementation((key: string, opts: unknown) => ({ __key: key, __opts: opts })));

import {
  loadBillingConfig, getStripe, isModeAvailable, __setBillingConfigForTests, STRIPE_API_VERSION, DEFAULT_INTEGRATION_ID,
} from '../config';
import { BillingUnavailableError } from '../errors';
import { fakeKey, fakeWebhookSecret } from '../../../test/billing/secrets';
import { testBillingConfig } from '../../../test/billing/config';

const base = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  STRIPE_TEST_SECRET_KEY: fakeKey('sk_test'),
  STRIPE_TEST_WEBHOOK_SECRETS: fakeWebhookSecret(),
  ...extra,
});

const prod = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  BILLING_ENV_TAG: 'prod',
  BILLING_PUBLIC_BASE_URL: 'https://api.rootaroo.com',
  STRIPE_TEST_SECRET_KEY: fakeKey('rk_test'),
  STRIPE_TEST_WEBHOOK_SECRETS: fakeWebhookSecret('t'),
  STRIPE_LIVE_SECRET_KEY: fakeKey('rk_live'),
  STRIPE_LIVE_WEBHOOK_SECRETS: fakeWebhookSecret('l'),
  ...extra,
});

describe('loadBillingConfig', () => {
  it('loads a dev config with test mode only and sensible defaults', () => {
    const cfg = loadBillingConfig(base());
    expect(cfg.envTag).toBe('dev');
    expect(cfg.graceDays).toBe(7);
    expect(cfg.integrationId).toBe(DEFAULT_INTEGRATION_ID);
    expect(cfg.modes.test).toEqual({ secretKey: fakeKey('sk_test'), webhookSecrets: [fakeWebhookSecret()] });
    expect(cfg.modes.live).toBeNull();
  });

  it('accepts two comma-separated webhook secrets for rotation', () => {
    const cfg = loadBillingConfig(base({ STRIPE_TEST_WEBHOOK_SECRETS: `${fakeWebhookSecret('a')}, ${fakeWebhookSecret('b')}` }));
    expect(cfg.modes.test!.webhookSecrets).toEqual([fakeWebhookSecret('a'), fakeWebhookSecret('b')]);
  });

  it('refuses a live key in the test variable', () => {
    expect(() => loadBillingConfig(base({ STRIPE_TEST_SECRET_KEY: fakeKey('sk_live') }))).toThrow(/not a test key/);
  });

  it('refuses a test key in the live variable', () => {
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_SECRET_KEY: fakeKey('sk_test') }))).toThrow(/not a live key/);
  });

  it('refuses any STRIPE_LIVE_* outside production', () => {
    expect(() => loadBillingConfig(base({ STRIPE_LIVE_WEBHOOK_SECRETS: fakeWebhookSecret() }))).toThrow(/outside production/);
  });

  it('refuses production without live key or secrets', () => {
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_SECRET_KEY: undefined }))).toThrow(/requires STRIPE_LIVE/);
    expect(() => loadBillingConfig(prod({ STRIPE_LIVE_WEBHOOK_SECRETS: '' }))).toThrow(/requires STRIPE_LIVE/);
  });

  it('refuses production unless BILLING_ENV_TAG is prod', () => {
    expect(() => loadBillingConfig(prod({ BILLING_ENV_TAG: 'dev' }))).toThrow(/must be 'prod'/);
  });

  it('refuses a short billing admin key', () => {
    expect(() => loadBillingConfig(base({ ADMIN_BILLING_API_KEY: 'short' }))).toThrow(/at least 32/);
  });

  it('refuses identical admin and billing keys (Review Focus 4)', () => {
    const same = 'k'.repeat(40);
    expect(() => loadBillingConfig(base({ ADMIN_BILLING_API_KEY: same, ADMIN_API_KEY: same }))).toThrow(/must differ/);
  });

  it('disables test mode with a warning when the test key is missing', () => {
    const cfg = loadBillingConfig(base({ STRIPE_TEST_SECRET_KEY: '' }));
    expect(cfg.modes.test).toBeNull();
    expect(cfg.warnings.join(' ')).toMatch(/test mode disabled/);
  });

  it('refuses a malformed integration identifier', () => {
    expect(() => loadBillingConfig(base({ STRIPE_INTEGRATION_ID: 'rootaroo_app_checkout_ABC' }))).toThrow(/STRIPE_INTEGRATION_ID/);
  });

  it('parses the IP allowlist', () => {
    expect(loadBillingConfig(base({ ADMIN_BILLING_IP_ALLOWLIST: '10.0.0.0/8, 203.0.113.7/32' })).adminIpAllowlist)
      .toEqual(['10.0.0.0/8', '203.0.113.7/32']);
  });
});

describe('getStripe', () => {
  afterEach(() => __setBillingConfigForTests(null));

  it('builds one pinned client per mode', () => {
    __setBillingConfigForTests(testBillingConfig());
    const a = getStripe('test') as any;
    const b = getStripe('test') as any;
    expect(a).toBe(b);
    expect(a.__key).toBe(fakeKey('sk_test'));
    expect(a.__opts).toMatchObject({ apiVersion: STRIPE_API_VERSION });
  });

  it('throws BillingUnavailableError for a disabled mode', () => {
    __setBillingConfigForTests(testBillingConfig());
    expect(isModeAvailable('live')).toBe(false);
    expect(() => getStripe('live')).toThrow(BillingUnavailableError);
  });
});
```

`server/src/modules/billing/__tests__/mode.test.ts`:
```ts
import { resolveMode, modeFromLivemode, livemodeOf } from '../mode';

describe('resolveMode', () => {
  it.each([
    ['development', 'live', 'test'],
    ['development', 'test', 'test'],
    ['test', 'live', 'test'],
    ['staging', 'live', 'test'],
    ['production', 'live', 'live'],
    ['production', 'test', 'test'],
  ] as const)('NODE_ENV=%s cohort=%s -> %s', (nodeEnv, cohort, expected) => {
    expect(resolveMode({ billingCohort: cohort }, nodeEnv)).toBe(expected);
  });

  it('maps livemode both ways', () => {
    expect(modeFromLivemode(true)).toBe('live');
    expect(modeFromLivemode(false)).toBe('test');
    expect(livemodeOf('live')).toBe(true);
    expect(livemodeOf('test')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/config.test.ts src/modules/billing/__tests__/mode.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `config.ts`**

```ts
import Stripe from 'stripe';
import logger from '../../shared/utils/logger';
import { BillingUnavailableError } from './errors';
import type { BillingMode } from './types';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
/** Spec §4.2: fixed integration label, 8 random letters chosen once. */
export const DEFAULT_INTEGRATION_ID = 'rootaroo_app_checkout_qhzmvtkd';

export type EnvTag = 'dev' | 'staging' | 'prod';
export interface ModeConfig { secretKey: string; webhookSecrets: string[] }
export interface BillingConfig {
  nodeEnv: string;
  envTag: EnvTag;
  graceDays: number;
  publicBaseUrl: string;
  integrationId: string;
  adminKey: string;
  adminIpAllowlist: string[];
  modes: Record<BillingMode, ModeConfig | null>;
  warnings: string[];
}

export class BillingConfigError extends Error {}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]+$/;

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadBillingConfig(src: NodeJS.ProcessEnv): BillingConfig {
  const nodeEnv = src.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  const envTag = (src.BILLING_ENV_TAG || (isProd ? '' : 'dev')) as EnvTag;
  if (!['dev', 'staging', 'prod'].includes(envTag)) errors.push('BILLING_ENV_TAG must be dev, staging or prod');
  if (isProd && envTag !== 'prod') errors.push("BILLING_ENV_TAG must be 'prod' in production");

  const testKey = src.STRIPE_TEST_SECRET_KEY || '';
  const testSecrets = list(src.STRIPE_TEST_WEBHOOK_SECRETS);
  const liveKey = src.STRIPE_LIVE_SECRET_KEY || '';
  const liveSecrets = list(src.STRIPE_LIVE_WEBHOOK_SECRETS);

  if (testKey && !TEST_KEY.test(testKey)) errors.push('STRIPE_TEST_SECRET_KEY is not a test key');
  if (liveKey && !LIVE_KEY.test(liveKey)) errors.push('STRIPE_LIVE_SECRET_KEY is not a live key');
  if ([...testSecrets, ...liveSecrets].some((s) => !WEBHOOK_SECRET.test(s))) {
    errors.push('webhook secrets must look like whsec_…');
  }
  if (!isProd && (liveKey || liveSecrets.length > 0)) errors.push('STRIPE_LIVE_* must not be set outside production');
  if (isProd && (!liveKey || liveSecrets.length === 0)) {
    errors.push('production requires STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_WEBHOOK_SECRETS');
  }

  const adminKey = src.ADMIN_BILLING_API_KEY || '';
  if (adminKey && adminKey.length < 32) errors.push('ADMIN_BILLING_API_KEY must be at least 32 characters');
  if (adminKey && src.ADMIN_API_KEY && adminKey === src.ADMIN_API_KEY) {
    errors.push('ADMIN_BILLING_API_KEY must differ from ADMIN_API_KEY');
  }

  const graceDays = Number(src.BILLING_GRACE_DAYS || '7');
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) errors.push('BILLING_GRACE_DAYS must be an integer 0..30');

  const fallbackBase = src.SERVER_BASE_URL || `http://localhost:${src.PORT || '3000'}`;
  const publicBaseUrl = (src.BILLING_PUBLIC_BASE_URL || (isProd ? '' : fallbackBase)).replace(/\/+$/, '');
  if (isProd && !publicBaseUrl.startsWith('https://')) errors.push('BILLING_PUBLIC_BASE_URL must be an https origin in production');

  const integrationId = src.STRIPE_INTEGRATION_ID || DEFAULT_INTEGRATION_ID;
  if (!/^rootaroo_app_checkout_[a-z]{8}$/.test(integrationId)) {
    errors.push('STRIPE_INTEGRATION_ID must be rootaroo_app_checkout_<8 lowercase letters>');
  }

  if (!testKey) warnings.push('STRIPE_TEST_SECRET_KEY is not set: test mode disabled (test-cohort households still bypass the paywall)');
  else if (testSecrets.length === 0) warnings.push('STRIPE_TEST_WEBHOOK_SECRETS is not set: test webhooks will be rejected');

  if (errors.length > 0) throw new BillingConfigError(errors.join('; '));

  return {
    nodeEnv,
    envTag,
    graceDays,
    publicBaseUrl,
    integrationId,
    adminKey,
    adminIpAllowlist: list(src.ADMIN_BILLING_IP_ALLOWLIST),
    modes: {
      test: testKey ? { secretKey: testKey, webhookSecrets: testSecrets } : null,
      live: liveKey ? { secretKey: liveKey, webhookSecrets: liveSecrets } : null,
    },
    warnings,
  };
}

let cached: BillingConfig | null = null;
const clients: Partial<Record<BillingMode, Stripe>> = {};

export function getBillingConfig(): BillingConfig {
  if (!cached) cached = loadBillingConfig(process.env);
  return cached;
}

export function isModeAvailable(mode: BillingMode): boolean {
  return getBillingConfig().modes[mode] !== null;
}

export function getStripe(mode: BillingMode): Stripe {
  const existing = clients[mode];
  if (existing) return existing;
  const modeCfg = getBillingConfig().modes[mode];
  if (!modeCfg) throw new BillingUnavailableError();
  const client = new Stripe(modeCfg.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'rootaroo-server' },
  });
  clients[mode] = client;
  return client;
}

/** Called first thing in index.ts start(): refuses to boot on a bad billing config (§4.2). */
export function assertBillingConfigAtStartup(): void {
  try {
    const cfg = getBillingConfig();
    for (const w of cfg.warnings) logger.warn(`[Billing] ${w}`);
    logger.info(`[Billing] env=${cfg.envTag} test=${cfg.modes.test ? 'on' : 'off'} live=${cfg.modes.live ? 'on' : 'off'}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: billing configuration invalid: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function __setBillingConfigForTests(cfg: BillingConfig | null): void {
  cached = cfg;
  delete clients.test;
  delete clients.live;
}

export function __setStripeForTests(mode: BillingMode, client: unknown | null): void {
  if (client === null) delete clients[mode];
  else clients[mode] = client as Stripe;
}
```
If `tsc` rejects `apiVersion: STRIPE_API_VERSION` because the SDK's `LatestApiVersion` literal differs, the SDK is not on the pinned version: go back to Task 0.1 Step 3. Do not cast.

- [ ] **Step 5: Implement `mode.ts`**

```ts
import { env } from '../../config/env';
import type { BillingCohort, BillingMode } from './types';

/** §4.3. Never used by webhooks or reconciliation, which take the mode from event.livemode. */
export function resolveMode(household: { billingCohort: BillingCohort }, nodeEnv: string = env.nodeEnv): BillingMode {
  if (nodeEnv !== 'production') return 'test';
  return household.billingCohort === 'test' ? 'test' : 'live';
}

export function modeFromLivemode(livemode: boolean): BillingMode {
  return livemode ? 'live' : 'test';
}

export function livemodeOf(mode: BillingMode): boolean {
  return mode === 'live';
}
```

- [ ] **Step 6: Wire the startup check**

In `server/src/index.ts` add `import { assertBillingConfigAtStartup } from './modules/billing/config';` and make it the first statement inside `start()`'s `try` block:
```ts
    assertBillingConfigAtStartup();
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/config.test.ts src/modules/billing/__tests__/mode.test.ts && npm run type-check`
Expected: PASS (all cases); type-check clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/billing/config.ts server/src/modules/billing/mode.ts server/src/modules/billing/__tests__/config.test.ts server/src/modules/billing/__tests__/mode.test.ts server/src/test/billing server/src/index.ts
git commit -F - <<'MSG'
feat(billing): config loading, startup guards, pinned Stripe clients, mode resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 2.4: Named locks and the fail-open cache

**Files:**
- Create: `server/src/modules/billing/locks.ts`, `server/src/modules/billing/cache.ts`
- Test: `server/src/modules/billing/__tests__/locks.test.ts`, `server/src/modules/billing/__tests__/cache.test.ts`, `server/src/modules/billing/__int__/locks.int.test.ts`

**Interfaces:**
- Consumes: `LockBusyError` (2.1), `redis` default export (`config/redis`), `sequelize` default export (`config/database`).
- Produces:
  - `withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>, opts?: { waitMs?: number; retryEveryMs?: number }): Promise<T>` (throws `LockBusyError`)
  - `mysqlLockName(name: string): string` (≤ 64 chars)
  - `cacheGetJson<T>(key: string): Promise<T | null>`, `cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void>`, `cacheDel(...keys: string[]): Promise<void>`, `publishMessage(channel: string, message: string): Promise<boolean>`, `entitlementKey(mode: BillingMode, householdId: string): string`, `CATALOG_BUST_CHANNEL = 'billing:catalog:bust'`

- [ ] **Step 1: Write the failing unit tests**

`server/src/modules/billing/__tests__/locks.test.ts`:
```ts
const redisMock = { status: 'ready', set: jest.fn(), eval: jest.fn().mockResolvedValue(1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

const conn = { query: jest.fn() };
const cm = { getConnection: jest.fn().mockResolvedValue(conn), releaseConnection: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: { connectionManager: cm } }));

import { withLock, mysqlLockName } from '../locks';
import { LockBusyError } from '../errors';

function mysqlReturns(...values: number[]) {
  const queue = [...values];
  conn.query.mockImplementation((sql: string, _p: unknown[], cb: (e: Error | null, r: unknown) => void) => {
    if (sql.startsWith('SELECT GET_LOCK')) cb(null, [{ ok: queue.shift() ?? 1 }]);
    else cb(null, [{ ok: 1 }]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.status = 'ready';
});

describe('withLock (Redis path)', () => {
  it('acquires with SET NX PX, runs fn, then releases with its own token', async () => {
    redisMock.set.mockResolvedValue('OK');
    const result = await withLock('billing:test', 5000, async () => 42);
    expect(result).toBe(42);
    const [key, token, px, ttl, nx] = redisMock.set.mock.calls[0];
    expect([key, px, ttl, nx]).toEqual(['lock:billing:test', 'PX', 5000, 'NX']);
    expect(redisMock.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('get'"), 1, 'lock:billing:test', token);
  });

  it('throws LockBusyError immediately when held and waitMs is 0', async () => {
    redisMock.set.mockResolvedValue(null);
    await expect(withLock('billing:test', 5000, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
  });

  it('retries until the lock frees up within waitMs', async () => {
    redisMock.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    await expect(withLock('billing:test', 5000, async () => 'ok', { waitMs: 1000, retryEveryMs: 5 })).resolves.toBe('ok');
    expect(redisMock.set).toHaveBeenCalledTimes(3);
  });

  it('releases even when fn throws', async () => {
    redisMock.set.mockResolvedValue('OK');
    await expect(withLock('billing:test', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(redisMock.eval).toHaveBeenCalled();
  });
});

describe('withLock (MySQL fallback, Review Focus 5)', () => {
  it('falls back to MySQL when Redis is not ready', async () => {
    redisMock.status = 'reconnecting';
    mysqlReturns(1);
    await expect(withLock('billing:x', 5000, async () => 'db')).resolves.toBe('db');
    expect(conn.query.mock.calls.map((c) => c[0])).toEqual(['SELECT GET_LOCK(?, ?) AS ok', 'SELECT RELEASE_LOCK(?) AS ok']);
    expect(cm.releaseConnection).toHaveBeenCalledWith(conn);
  });

  it('falls back to MySQL when a Redis command throws', async () => {
    redisMock.set.mockRejectedValue(new Error('ECONNRESET'));
    mysqlReturns(1);
    await expect(withLock('billing:x', 5000, async () => 'db')).resolves.toBe('db');
  });

  it('throws LockBusyError when GET_LOCK returns 0', async () => {
    redisMock.status = 'end';
    mysqlReturns(0);
    await expect(withLock('billing:x', 5000, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    expect(cm.releaseConnection).toHaveBeenCalled();
  });
});

describe('mysqlLockName', () => {
  it('keeps short names and hashes long ones to <= 64 chars', () => {
    expect(mysqlLockName('billing:sub:sub_123')).toBe('billing:sub:sub_123');
    const long = mysqlLockName(`billing:checkout:${'a'.repeat(60)}:test`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith('billing:')).toBe(true);
  });
});
```

`server/src/modules/billing/__tests__/cache.test.ts`:
```ts
const redisMock: any = { status: 'ready', get: jest.fn(), set: jest.fn(), del: jest.fn(), publish: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

import { cacheGetJson, cacheSetJson, cacheDel, publishMessage, entitlementKey } from '../cache';

beforeEach(() => { jest.clearAllMocks(); redisMock.status = 'ready'; });

describe('billing cache', () => {
  it('round-trips JSON with a TTL', async () => {
    await cacheSetJson('k', { a: 1 }, 60);
    expect(redisMock.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 60);
    redisMock.get.mockResolvedValue('{"a":1}');
    await expect(cacheGetJson('k')).resolves.toEqual({ a: 1 });
  });

  it('fails open when Redis is down or throws', async () => {
    redisMock.status = 'end';
    await expect(cacheGetJson('k')).resolves.toBeNull();
    await expect(cacheSetJson('k', 1, 60)).resolves.toBeUndefined();
    redisMock.status = 'ready';
    redisMock.get.mockRejectedValue(new Error('down'));
    await expect(cacheGetJson('k')).resolves.toBeNull();
    redisMock.del.mockRejectedValue(new Error('down'));
    await expect(cacheDel('k')).resolves.toBeUndefined();
    redisMock.publish.mockRejectedValue(new Error('down'));
    await expect(publishMessage('c', 'm')).resolves.toBe(false);
  });

  it('builds mode-keyed entitlement keys', () => {
    expect(entitlementKey('live', 'h1')).toBe('billing:ent:live:h1');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/locks.test.ts src/modules/billing/__tests__/cache.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `locks.ts`**

```ts
import crypto from 'crypto';
import redis from '../../config/redis';
import sequelize from '../../config/database';
import logger from '../../shared/utils/logger';
import { LockBusyError } from './errors';

export interface LockOptions { waitMs?: number; retryEveryMs?: number }

type RawConn = { query(sql: string, params: unknown[], cb: (err: Error | null, rows: unknown) => void): void };
type ConnManager = {
  getConnection(opts: { type: 'write' }): Promise<RawConn>;
  releaseConnection(conn: RawConn): Promise<void>;
};

const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mysqlLockName(name: string): string {
  if (name.length <= 64) return name;
  return `billing:${crypto.createHash('sha1').update(name).digest('hex')}`;
}

function rawQuery(conn: RawConn, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as Array<Record<string, unknown>>)));
  });
}

async function withMysqlLock<T>(name: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  const cm = sequelize.connectionManager as unknown as ConnManager;
  const conn = await cm.getConnection({ type: 'write' });
  const lockName = mysqlLockName(name);
  try {
    const rows = await rawQuery(conn, 'SELECT GET_LOCK(?, ?) AS ok', [lockName, Math.ceil(waitMs / 1000)]);
    if (Number(rows[0]?.ok) !== 1) throw new LockBusyError(name);
    try {
      return await fn();
    } finally {
      await rawQuery(conn, 'SELECT RELEASE_LOCK(?) AS ok', [lockName]).catch(() => undefined);
    }
  } finally {
    await cm.releaseConnection(conn);
  }
}

/**
 * Runs fn while holding a cluster-wide named lock. Redis SET NX PX when Redis is
 * ready, MySQL GET_LOCK otherwise (spec §3 locks.ts). Never hold a DB transaction
 * across fn's network calls: fn opens its own short transactions.
 */
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 0;
  const every = opts.retryEveryMs ?? 100;
  if (redis.status !== 'ready') return withMysqlLock(name, fn, waitMs);

  const key = `lock:${name}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    for (;;) {
      acquired = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
      if (acquired || Date.now() >= deadline) break;
      await sleep(every);
    }
  } catch (err) {
    logger.warn(`[Billing] Redis lock error on ${name}, falling back to MySQL: ${(err as Error).message}`);
    return withMysqlLock(name, fn, waitMs);
  }
  if (!acquired) throw new LockBusyError(name);
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
```

- [ ] **Step 4: Implement `cache.ts`**

```ts
import redis from '../../config/redis';
import type { BillingMode } from './types';

export const CATALOG_BUST_CHANNEL = 'billing:catalog:bust';

export function entitlementKey(mode: BillingMode, householdId: string): string {
  return `billing:ent:${mode}:${householdId}`;
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (redis.status !== 'ready') return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (redis.status !== 'ready') return;
  await redis.set(key, JSON.stringify(value), 'EX', ttlSec).catch(() => undefined);
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (redis.status !== 'ready' || keys.length === 0) return;
  await redis.del(...keys).catch(() => undefined);
}

export async function publishMessage(channel: string, message: string): Promise<boolean> {
  if (redis.status !== 'ready') return false;
  try {
    await redis.publish(channel, message);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/locks.test.ts src/modules/billing/__tests__/cache.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the integration test (real MySQL GET_LOCK)**

`server/src/modules/billing/__int__/locks.int.test.ts`:
```ts
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end', disconnect: jest.fn() } }));

import { withLock } from '../locks';
import { LockBusyError } from '../errors';
import { closeIntResources } from '../../../test/int/db';

afterAll(() => closeIntResources());

describe('withLock against MySQL (Review Focus 5)', () => {
  it('excludes a concurrent holder and frees on completion', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const first = withLock('billing:int:probe', 10_000, () => held);
    await new Promise((r) => setTimeout(r, 100));
    await expect(withLock('billing:int:probe', 10_000, async () => 'second')).rejects.toBeInstanceOf(LockBusyError);
    release();
    await first;
    await expect(withLock('billing:int:probe', 10_000, async () => 'third')).resolves.toBe('third');
  });
});
```
Run: `cd server && npm run test:int -- src/modules/billing/__int__/locks.int.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/billing/locks.ts server/src/modules/billing/cache.ts server/src/modules/billing/__tests__/locks.test.ts server/src/modules/billing/__tests__/cache.test.ts server/src/modules/billing/__int__/locks.int.test.ts
git commit -F - <<'MSG'
feat(billing): named locks with MySQL fallback and fail-open cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 2.5: Migrations and models (§5)

**Files:**
- Create: `server/src/database/billingSeeds.js`, `server/src/database/migrations/20261001-add-billing-cohort-to-households.js`, `server/src/database/migrations/20261002-create-billing-core-tables.js`, `server/src/database/migrations/20261003-create-billing-ledger-tables.js`, `server/src/database/migrations/20261004-create-billing-routing-rules.js`
- Create models: `server/src/database/models/{BillingCustomer,BillingSubscription,BillingCheckoutSession,BillingEvent,BillingTransaction,BillingRoutingRule,BillingPriceNotice,BillingReconciliationRun,BillingReconciliationItem,AdminAuditLog}.ts`
- Modify: `server/src/database/models/Household.ts`, `server/src/database/models/index.ts`, `server/src/test/factories.ts` (no change needed; `cohort` now valid)
- Test: `server/src/database/__tests__/billingSeeds.test.ts`, `server/src/modules/billing/__int__/models.int.test.ts`

**Interfaces:**
- Produces (all models `paranoid: false`, `underscored`, explicit `field`):
  - `Household.billingCohort: 'live'|'test'`
  - `BillingCustomer { id, householdId, provider, livemode, providerCustomerId, billingEmail: string|null }`
  - `BillingSubscription { id, householdId, provider, livemode, providerSubscriptionId, status: SubscriptionStatus, interval: BillingInterval, seats, priceId: string|null, priceSet: string|null, unitAmount: number|null, currency: string|null, currentPeriodStart: Date|null, currentPeriodEnd: Date|null, cancelAtPeriodEnd: boolean, canceledAt: Date|null, endedAt: Date|null, pendingUpdate: Record<string, unknown>|null, graceUntil: Date|null, purchasedByUserId: string|null, eventWatermark: number|null, lastSyncedAt: Date|null, createdAt, updatedAt }`
  - `BillingCheckoutSession { id, householdId, livemode, providerSessionId: string|null, createdByUserId, interval, seats, status: 'creating'|'open'|'complete'|'expired'|'failed', url: string|null, expiresAt: Date|null, createdAt, updatedAt }`
  - `BillingEvent { id, provider, livemode, providerEventId, type, payload: Record<string, unknown>, status: 'received'|'processing'|'processed'|'failed'|'ignored'|'dead', attempts, lockedAt: Date|null, lastError: string|null, receivedAt: Date, processedAt: Date|null, createdAt, updatedAt }`
  - `BillingTransaction { id, provider, livemode, type: 'payment'|'failed_payment'|'refund'|'dispute', status, billingReason: string|null, amount, fee: number|null, net: number|null, disputeFee: number|null, fundsState: 'none'|'withdrawn'|'reinstated'|null, currency, householdId: string|null, userId: string|null, subscriptionId: string|null, matchStatus: 'matched'|'unmatched', householdNameSnapshot: string|null, payerEmailSnapshot: string|null, providerObjectId, providerInvoiceId: string|null, providerChargeId: string|null, receiptUrl: string|null, description: string|null, occurredAt: Date, lastEventId: string|null, createdAt, updatedAt }`
  - `BillingRoutingRule { id, platform: 'ios'|'android'|'web', country: string, method: PurchaseMethod, updatedBy: string, createdAt, updatedAt }`
  - `BillingPriceNotice { id, subscriptionId, fromPriceId, toPriceSet, noticeSentAt: Date, applyAfter: Date, appliedAt: Date|null, status: 'scheduled'|'applied'|'skipped'|'failed', reason: string|null }`
  - `BillingReconciliationRun { id, livemode, kind: 'daily'|'weekly'|'manual', startedAt: Date, finishedAt: Date|null, status: 'running'|'succeeded'|'failed', counts: Record<string, number>|null }`
  - `BillingReconciliationItem { id, runId: string|null, livemode, kind, entityType, entityId: string|null, providerObjectId: string|null, before: unknown, after: unknown, resolution: 'auto_fixed'|'needs_review'|'resolved'|'ignored', resolvedBy: string|null, resolutionNote: string|null, resolvedAt: Date|null, createdAt, updatedAt }`
  - `AdminAuditLog { id, surface: 'admin'|'billing-admin', keyLabel, method, path, query: unknown, bodyDigest: string|null, statusCode: number, ip: string|null, createdAt }`
  - `billingSeeds.js`: `defaultRoutingRules(nodeEnv: string): Array<{ platform: string; country: string; method: string }>`

Deviation from the spec's column list (recorded in the self-review): `billing_transactions.funds_state ENUM('none','withdrawn','reinstated') NULL`, because §8.5 requires the dispute "funds state" to be kept and §11's summary subtracts "funds withdrawn and not reinstated", and no listed column holds it.

- [ ] **Step 1: Write the failing seed test**

`server/src/database/__tests__/billingSeeds.test.ts`:
```ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defaultRoutingRules } = require('../billingSeeds');

describe('defaultRoutingRules (§5.7)', () => {
  it('routes every platform to Stripe outside production', () => {
    expect(defaultRoutingRules('development')).toEqual([
      { platform: 'ios', country: '*', method: 'stripe_checkout' },
      { platform: 'android', country: '*', method: 'stripe_checkout' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ]);
  });

  it('uses the launch rules in production', () => {
    expect(defaultRoutingRules('production')).toEqual([
      { platform: 'ios', country: 'US', method: 'stripe_checkout' },
      { platform: 'android', country: 'US', method: 'stripe_checkout' },
      { platform: 'ios', country: '*', method: 'apple_iap' },
      { platform: 'android', country: '*', method: 'google_play' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ]);
  });
});
```
Run: `cd server && npx jest src/database/__tests__/billingSeeds.test.ts` → FAIL (module missing).

Note: `jest.config.js` `collectCoverageFrom` excludes `src/database/**`, but tests there still run.

- [ ] **Step 2: Write `server/src/database/billingSeeds.js`**

```js
'use strict';
// Shared by the routing-rules migration and tests. Lives outside migrations/
// because sequelize-cli executes every file in that folder.
function defaultRoutingRules(nodeEnv) {
  if (nodeEnv === 'production') {
    return [
      { platform: 'ios', country: 'US', method: 'stripe_checkout' },
      { platform: 'android', country: 'US', method: 'stripe_checkout' },
      { platform: 'ios', country: '*', method: 'apple_iap' },
      { platform: 'android', country: '*', method: 'google_play' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ];
  }
  return [
    { platform: 'ios', country: '*', method: 'stripe_checkout' },
    { platform: 'android', country: '*', method: 'stripe_checkout' },
    { platform: 'web', country: '*', method: 'stripe_checkout' },
  ];
}

module.exports = { defaultRoutingRules };
```
Run the seed test → PASS.

- [ ] **Step 3: Write the four migrations**

`20261001-add-billing-cohort-to-households.js`:
```js
'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/** Spec §5.1: per-household billing cohort; 'test' bypasses the paywall and uses a Stripe sandbox. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'households', 'billing_cohort', {
      type: Sequelize.ENUM('live', 'test'),
      allowNull: false,
      defaultValue: 'live',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('households', 'billing_cohort');
  },
};
```

`20261002-create-billing-core-tables.js`:
```js
'use strict';

/** Spec §5.2–5.5: customers, subscriptions, checkout sessions, webhook events. */
const timestamps = (Sequelize) => ({
  created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
});
const householdFk = (Sequelize) => ({
  type: Sequelize.UUID, allowNull: false,
  references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
});
const PROVIDERS = ['stripe', 'apple', 'google'];
const STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_customers', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      household_id: householdFk(Sequelize),
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_customer_id: { type: Sequelize.STRING(255), allowNull: false },
      billing_email: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_customers', ['household_id', 'provider', 'livemode'], { unique: true, name: 'uq_billing_customers_household_mode' });
    await queryInterface.addIndex('billing_customers', ['provider', 'livemode', 'provider_customer_id'], { unique: true, name: 'uq_billing_customers_provider_id' });

    await queryInterface.createTable('billing_subscriptions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      household_id: householdFk(Sequelize),
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_subscription_id: { type: Sequelize.STRING(255), allowNull: false },
      status: { type: Sequelize.ENUM(...STATUSES), allowNull: false },
      interval: { type: Sequelize.ENUM('month', 'year'), allowNull: false },
      seats: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      price_id: { type: Sequelize.STRING(255), allowNull: true },
      price_set: { type: Sequelize.STRING(32), allowNull: true },
      unit_amount: { type: Sequelize.INTEGER, allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: true },
      current_period_start: { type: Sequelize.DATE, allowNull: true },
      current_period_end: { type: Sequelize.DATE, allowNull: true },
      cancel_at_period_end: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      canceled_at: { type: Sequelize.DATE, allowNull: true },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      pending_update: { type: Sequelize.JSON, allowNull: true },
      grace_until: { type: Sequelize.DATE, allowNull: true },
      purchased_by_user_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      event_watermark: { type: Sequelize.BIGINT, allowNull: true },
      last_synced_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_subscriptions', ['provider', 'livemode', 'provider_subscription_id'], { unique: true, name: 'uq_billing_subscriptions_provider_id' });
    await queryInterface.addIndex('billing_subscriptions', ['household_id', 'livemode', 'status'], { name: 'idx_billing_subscriptions_household_mode_status' });

    await queryInterface.createTable('billing_checkout_sessions', {
      id: { type: Sequelize.UUID, primaryKey: true },
      household_id: householdFk(Sequelize),
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_session_id: { type: Sequelize.STRING(255), allowNull: true, unique: true },
      created_by_user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      interval: { type: Sequelize.ENUM('month', 'year'), allowNull: false },
      seats: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      status: { type: Sequelize.ENUM('creating', 'open', 'complete', 'expired', 'failed'), allowNull: false, defaultValue: 'creating' },
      url: { type: Sequelize.TEXT, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_checkout_sessions', ['household_id', 'livemode', 'status'], { name: 'idx_billing_checkout_household_mode_status' });

    await queryInterface.createTable('billing_events', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_event_id: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.ENUM('received', 'processing', 'processed', 'failed', 'ignored', 'dead'), allowNull: false, defaultValue: 'received' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      locked_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      received_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_events', ['status', 'updated_at'], { name: 'idx_billing_events_status_updated' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('billing_events');
    await queryInterface.dropTable('billing_checkout_sessions');
    await queryInterface.dropTable('billing_subscriptions');
    await queryInterface.dropTable('billing_customers');
  },
};
```

`20261003-create-billing-ledger-tables.js`:
```js
'use strict';

/** Spec §5.6, §5.8–5.10: ledger, price notices, reconciliation, audit log. */
const timestamps = (Sequelize) => ({
  created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_transactions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      provider: { type: Sequelize.ENUM('stripe', 'apple', 'google'), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      type: { type: Sequelize.ENUM('payment', 'failed_payment', 'refund', 'dispute'), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false },
      billing_reason: { type: Sequelize.STRING(40), allowNull: true },
      amount: { type: Sequelize.INTEGER, allowNull: false },
      fee: { type: Sequelize.INTEGER, allowNull: true },
      net: { type: Sequelize.INTEGER, allowNull: true },
      dispute_fee: { type: Sequelize.INTEGER, allowNull: true },
      funds_state: { type: Sequelize.ENUM('none', 'withdrawn', 'reinstated'), allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: false },
      household_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      subscription_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'billing_subscriptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      match_status: { type: Sequelize.ENUM('matched', 'unmatched'), allowNull: false },
      household_name_snapshot: { type: Sequelize.STRING(100), allowNull: true },
      payer_email_snapshot: { type: Sequelize.STRING(255), allowNull: true },
      provider_object_id: { type: Sequelize.STRING(255), allowNull: false },
      provider_invoice_id: { type: Sequelize.STRING(255), allowNull: true },
      provider_charge_id: { type: Sequelize.STRING(255), allowNull: true },
      receipt_url: { type: Sequelize.TEXT, allowNull: true },
      description: { type: Sequelize.STRING(500), allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      last_event_id: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_transactions', ['provider', 'livemode', 'type', 'provider_object_id'], { unique: true, name: 'uq_billing_transactions_identity' });
    await queryInterface.addIndex('billing_transactions', ['livemode', 'occurred_at'], { name: 'idx_billing_transactions_mode_time' });
    await queryInterface.addIndex('billing_transactions', ['household_id', 'occurred_at'], { name: 'idx_billing_transactions_household_time' });
    await queryInterface.addIndex('billing_transactions', ['user_id'], { name: 'idx_billing_transactions_user' });

    await queryInterface.createTable('billing_price_notices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      subscription_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'billing_subscriptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      from_price_id: { type: Sequelize.STRING(255), allowNull: false },
      to_price_set: { type: Sequelize.STRING(32), allowNull: false },
      notice_sent_at: { type: Sequelize.DATE, allowNull: false },
      apply_after: { type: Sequelize.DATE, allowNull: false },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('scheduled', 'applied', 'skipped', 'failed'), allowNull: false, defaultValue: 'scheduled' },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_price_notices', ['subscription_id', 'to_price_set'], { unique: true, name: 'uq_billing_price_notices_sub_set' });

    await queryInterface.createTable('billing_reconciliation_runs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      kind: { type: Sequelize.ENUM('daily', 'weekly', 'manual'), allowNull: false },
      started_at: { type: Sequelize.DATE, allowNull: false },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('running', 'succeeded', 'failed'), allowNull: false, defaultValue: 'running' },
      counts: { type: Sequelize.JSON, allowNull: true },
      ...timestamps(Sequelize),
    });

    await queryInterface.createTable('billing_reconciliation_items', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      run_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'billing_reconciliation_runs', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      kind: { type: Sequelize.STRING(64), allowNull: false },
      entity_type: { type: Sequelize.STRING(32), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: true },
      provider_object_id: { type: Sequelize.STRING(255), allowNull: true },
      before: { type: Sequelize.JSON, allowNull: true },
      after: { type: Sequelize.JSON, allowNull: true },
      resolution: { type: Sequelize.ENUM('auto_fixed', 'needs_review', 'resolved', 'ignored'), allowNull: false },
      resolved_by: { type: Sequelize.STRING(100), allowNull: true },
      resolution_note: { type: Sequelize.STRING(1000), allowNull: true },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_reconciliation_items', ['resolution', 'created_at'], { name: 'idx_billing_recon_items_resolution' });
    await queryInterface.addIndex('billing_reconciliation_items', ['kind', 'provider_object_id'], { name: 'idx_billing_recon_items_kind_object' });

    await queryInterface.createTable('admin_audit_log', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      surface: { type: Sequelize.ENUM('admin', 'billing-admin'), allowNull: false },
      key_label: { type: Sequelize.STRING(64), allowNull: false },
      method: { type: Sequelize.STRING(10), allowNull: false },
      path: { type: Sequelize.STRING(500), allowNull: false },
      query: { type: Sequelize.JSON, allowNull: true },
      body_digest: { type: Sequelize.CHAR(64), allowNull: true },
      status_code: { type: Sequelize.INTEGER, allowNull: false },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('admin_audit_log', ['surface', 'created_at'], { name: 'idx_admin_audit_log_surface_time' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('admin_audit_log');
    await queryInterface.dropTable('billing_reconciliation_items');
    await queryInterface.dropTable('billing_reconciliation_runs');
    await queryInterface.dropTable('billing_price_notices');
    await queryInterface.dropTable('billing_transactions');
  },
};
```

`20261004-create-billing-routing-rules.js`:
```js
'use strict';

const crypto = require('crypto');
const { defaultRoutingRules } = require('../billingSeeds');

/** Spec §5.7 + §12: which purchase method each platform/country sees. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_routing_rules', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      platform: { type: Sequelize.ENUM('ios', 'android', 'web'), allowNull: false },
      country: { type: Sequelize.STRING(2), allowNull: false },
      method: { type: Sequelize.ENUM('stripe_checkout', 'apple_iap', 'google_play', 'none'), allowNull: false },
      updated_by: { type: Sequelize.STRING(100), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('billing_routing_rules', ['platform', 'country'], { unique: true, name: 'uq_billing_routing_rules_platform_country' });

    const now = new Date();
    await queryInterface.bulkInsert('billing_routing_rules', defaultRoutingRules(process.env.NODE_ENV || 'development').map((r) => ({
      id: crypto.randomUUID(), platform: r.platform, country: r.country, method: r.method,
      updated_by: 'migration', created_at: now, updated_at: now,
    })));
  },

  async down(queryInterface) {
    await queryInterface.dropTable('billing_routing_rules');
  },
};
```

- [ ] **Step 4: Write the models**

`Household.ts`: add `declare billingCohort: CreationOptional<'live' | 'test'>;` to the class and this attribute after `timezone`:
```ts
    billingCohort: {
      type: DataTypes.ENUM('live', 'test'),
      allowNull: false,
      defaultValue: 'live',
      field: 'billing_cohort',
    },
```

`BillingCustomer.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingCustomer extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare providerCustomerId: string;
  declare billingEmail: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingCustomer.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerCustomerId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_customer_id' },
    billingEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'billing_email' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_customers', paranoid: false },
);

export default BillingCustomer;
```

`BillingSubscription.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { BillingInterval, BillingProvider, SubscriptionStatus } from '../../modules/billing/types';

class BillingSubscription extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare provider: BillingProvider;
  declare livemode: boolean;
  declare providerSubscriptionId: string;
  declare status: SubscriptionStatus;
  declare interval: BillingInterval;
  declare seats: number;
  declare priceId: string | null;
  declare priceSet: string | null;
  declare unitAmount: number | null;
  declare currency: string | null;
  declare currentPeriodStart: Date | null;
  declare currentPeriodEnd: Date | null;
  declare cancelAtPeriodEnd: CreationOptional<boolean>;
  declare canceledAt: Date | null;
  declare endedAt: Date | null;
  declare pendingUpdate: Record<string, unknown> | null;
  declare graceUntil: Date | null;
  declare purchasedByUserId: string | null;
  declare eventWatermark: number | null;
  declare lastSyncedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingSubscription.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerSubscriptionId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_subscription_id' },
    status: {
      type: DataTypes.ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'),
      allowNull: false,
    },
    interval: { type: DataTypes.ENUM('month', 'year'), allowNull: false },
    seats: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    priceId: { type: DataTypes.STRING(255), allowNull: true, field: 'price_id' },
    priceSet: { type: DataTypes.STRING(32), allowNull: true, field: 'price_set' },
    unitAmount: { type: DataTypes.INTEGER, allowNull: true, field: 'unit_amount' },
    currency: { type: DataTypes.CHAR(3), allowNull: true },
    currentPeriodStart: { type: DataTypes.DATE, allowNull: true, field: 'current_period_start' },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true, field: 'current_period_end' },
    cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'cancel_at_period_end' },
    canceledAt: { type: DataTypes.DATE, allowNull: true, field: 'canceled_at' },
    endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
    pendingUpdate: { type: DataTypes.JSON, allowNull: true, field: 'pending_update' },
    graceUntil: { type: DataTypes.DATE, allowNull: true, field: 'grace_until' },
    purchasedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'purchased_by_user_id' },
    eventWatermark: { type: DataTypes.BIGINT, allowNull: true, field: 'event_watermark' },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_synced_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_subscriptions', paranoid: false },
);

export default BillingSubscription;
```

`BillingCheckoutSession.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { BillingInterval } from '../../modules/billing/types';

export type CheckoutRowStatus = 'creating' | 'open' | 'complete' | 'expired' | 'failed';

class BillingCheckoutSession extends Model {
  declare id: string;
  declare householdId: string;
  declare livemode: boolean;
  declare providerSessionId: string | null;
  declare createdByUserId: string;
  declare interval: BillingInterval;
  declare seats: number;
  declare status: CreationOptional<CheckoutRowStatus>;
  declare url: string | null;
  declare expiresAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingCheckoutSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerSessionId: { type: DataTypes.STRING(255), allowNull: true, unique: true, field: 'provider_session_id' },
    createdByUserId: { type: DataTypes.UUID, allowNull: false, field: 'created_by_user_id' },
    interval: { type: DataTypes.ENUM('month', 'year'), allowNull: false },
    seats: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.ENUM('creating', 'open', 'complete', 'expired', 'failed'), allowNull: false, defaultValue: 'creating' },
    url: { type: DataTypes.TEXT, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_checkout_sessions', paranoid: false },
);

export default BillingCheckoutSession;
```

`BillingEvent.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type BillingEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored' | 'dead';

class BillingEvent extends Model {
  declare id: CreationOptional<string>;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare providerEventId: string;
  declare type: string;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<BillingEventStatus>;
  declare attempts: CreationOptional<number>;
  declare lockedAt: Date | null;
  declare lastError: string | null;
  declare receivedAt: Date;
  declare processedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerEventId: { type: DataTypes.STRING(255), allowNull: false, unique: true, field: 'provider_event_id' },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM('received', 'processing', 'processed', 'failed', 'ignored', 'dead'), allowNull: false, defaultValue: 'received' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockedAt: { type: DataTypes.DATE, allowNull: true, field: 'locked_at' },
    lastError: { type: DataTypes.TEXT, allowNull: true, field: 'last_error' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
    processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_events', paranoid: false },
);

export default BillingEvent;
```

`BillingTransaction.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type LedgerType = 'payment' | 'failed_payment' | 'refund' | 'dispute';
export type FundsState = 'none' | 'withdrawn' | 'reinstated';

class BillingTransaction extends Model {
  declare id: CreationOptional<string>;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare type: LedgerType;
  declare status: string;
  declare billingReason: string | null;
  declare amount: number;
  declare fee: number | null;
  declare net: number | null;
  declare disputeFee: number | null;
  declare fundsState: FundsState | null;
  declare currency: string;
  declare householdId: string | null;
  declare userId: string | null;
  declare subscriptionId: string | null;
  declare matchStatus: 'matched' | 'unmatched';
  declare householdNameSnapshot: string | null;
  declare payerEmailSnapshot: string | null;
  declare providerObjectId: string;
  declare providerInvoiceId: string | null;
  declare providerChargeId: string | null;
  declare receiptUrl: string | null;
  declare description: string | null;
  declare occurredAt: Date;
  declare lastEventId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingTransaction.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    type: { type: DataTypes.ENUM('payment', 'failed_payment', 'refund', 'dispute'), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false },
    billingReason: { type: DataTypes.STRING(40), allowNull: true, field: 'billing_reason' },
    amount: { type: DataTypes.INTEGER, allowNull: false },
    fee: { type: DataTypes.INTEGER, allowNull: true },
    net: { type: DataTypes.INTEGER, allowNull: true },
    disputeFee: { type: DataTypes.INTEGER, allowNull: true, field: 'dispute_fee' },
    fundsState: { type: DataTypes.ENUM('none', 'withdrawn', 'reinstated'), allowNull: true, field: 'funds_state' },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    householdId: { type: DataTypes.UUID, allowNull: true, field: 'household_id' },
    userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
    subscriptionId: { type: DataTypes.UUID, allowNull: true, field: 'subscription_id' },
    matchStatus: { type: DataTypes.ENUM('matched', 'unmatched'), allowNull: false, field: 'match_status' },
    householdNameSnapshot: { type: DataTypes.STRING(100), allowNull: true, field: 'household_name_snapshot' },
    payerEmailSnapshot: { type: DataTypes.STRING(255), allowNull: true, field: 'payer_email_snapshot' },
    providerObjectId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_object_id' },
    providerInvoiceId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_invoice_id' },
    providerChargeId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_charge_id' },
    receiptUrl: { type: DataTypes.TEXT, allowNull: true, field: 'receipt_url' },
    description: { type: DataTypes.STRING(500), allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
    lastEventId: { type: DataTypes.STRING(255), allowNull: true, field: 'last_event_id' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_transactions', paranoid: false },
);

export default BillingTransaction;
```

`BillingRoutingRule.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { ClientPlatform, PurchaseMethod } from '../../modules/billing/types';

class BillingRoutingRule extends Model {
  declare id: CreationOptional<string>;
  declare platform: ClientPlatform;
  declare country: string;
  declare method: PurchaseMethod;
  declare updatedBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingRoutingRule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    platform: { type: DataTypes.ENUM('ios', 'android', 'web'), allowNull: false },
    country: { type: DataTypes.STRING(2), allowNull: false },
    method: { type: DataTypes.ENUM('stripe_checkout', 'apple_iap', 'google_play', 'none'), allowNull: false },
    updatedBy: { type: DataTypes.STRING(100), allowNull: false, field: 'updated_by' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_routing_rules', paranoid: false },
);

export default BillingRoutingRule;
```

`BillingPriceNotice.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingPriceNotice extends Model {
  declare id: CreationOptional<string>;
  declare subscriptionId: string;
  declare fromPriceId: string;
  declare toPriceSet: string;
  declare noticeSentAt: Date;
  declare applyAfter: Date;
  declare appliedAt: Date | null;
  declare status: CreationOptional<'scheduled' | 'applied' | 'skipped' | 'failed'>;
  declare reason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingPriceNotice.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
    fromPriceId: { type: DataTypes.STRING(255), allowNull: false, field: 'from_price_id' },
    toPriceSet: { type: DataTypes.STRING(32), allowNull: false, field: 'to_price_set' },
    noticeSentAt: { type: DataTypes.DATE, allowNull: false, field: 'notice_sent_at' },
    applyAfter: { type: DataTypes.DATE, allowNull: false, field: 'apply_after' },
    appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
    status: { type: DataTypes.ENUM('scheduled', 'applied', 'skipped', 'failed'), allowNull: false, defaultValue: 'scheduled' },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_price_notices', paranoid: false },
);

export default BillingPriceNotice;
```

`BillingReconciliationRun.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingReconciliationRun extends Model {
  declare id: CreationOptional<string>;
  declare livemode: boolean;
  declare kind: 'daily' | 'weekly' | 'manual';
  declare startedAt: Date;
  declare finishedAt: Date | null;
  declare status: CreationOptional<'running' | 'succeeded' | 'failed'>;
  declare counts: Record<string, number> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingReconciliationRun.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    kind: { type: DataTypes.ENUM('daily', 'weekly', 'manual'), allowNull: false },
    startedAt: { type: DataTypes.DATE, allowNull: false, field: 'started_at' },
    finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    status: { type: DataTypes.ENUM('running', 'succeeded', 'failed'), allowNull: false, defaultValue: 'running' },
    counts: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_reconciliation_runs', paranoid: false },
);

export default BillingReconciliationRun;
```

`BillingReconciliationItem.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type ReviewResolution = 'auto_fixed' | 'needs_review' | 'resolved' | 'ignored';

class BillingReconciliationItem extends Model {
  declare id: CreationOptional<string>;
  declare runId: string | null;
  declare livemode: boolean;
  declare kind: string;
  declare entityType: string;
  declare entityId: string | null;
  declare providerObjectId: string | null;
  declare before: unknown;
  declare after: unknown;
  declare resolution: ReviewResolution;
  declare resolvedBy: string | null;
  declare resolutionNote: string | null;
  declare resolvedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingReconciliationItem.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    runId: { type: DataTypes.UUID, allowNull: true, field: 'run_id' },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    kind: { type: DataTypes.STRING(64), allowNull: false },
    entityType: { type: DataTypes.STRING(32), allowNull: false, field: 'entity_type' },
    entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
    providerObjectId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_object_id' },
    before: { type: DataTypes.JSON, allowNull: true },
    after: { type: DataTypes.JSON, allowNull: true },
    resolution: { type: DataTypes.ENUM('auto_fixed', 'needs_review', 'resolved', 'ignored'), allowNull: false },
    resolvedBy: { type: DataTypes.STRING(100), allowNull: true, field: 'resolved_by' },
    resolutionNote: { type: DataTypes.STRING(1000), allowNull: true, field: 'resolution_note' },
    resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_reconciliation_items', paranoid: false },
);

export default BillingReconciliationItem;
```

`AdminAuditLog.ts`:
```ts
import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class AdminAuditLog extends Model {
  declare id: CreationOptional<string>;
  declare surface: 'admin' | 'billing-admin';
  declare keyLabel: string;
  declare method: string;
  declare path: string;
  declare query: unknown;
  declare bodyDigest: string | null;
  declare statusCode: number;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;
}

AdminAuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    surface: { type: DataTypes.ENUM('admin', 'billing-admin'), allowNull: false },
    keyLabel: { type: DataTypes.STRING(64), allowNull: false, field: 'key_label' },
    method: { type: DataTypes.STRING(10), allowNull: false },
    path: { type: DataTypes.STRING(500), allowNull: false },
    query: { type: DataTypes.JSON, allowNull: true },
    bodyDigest: { type: DataTypes.CHAR(64), allowNull: true, field: 'body_digest' },
    statusCode: { type: DataTypes.INTEGER, allowNull: false, field: 'status_code' },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
  },
  { sequelize, tableName: 'admin_audit_log', paranoid: false, updatedAt: false },
);

export default AdminAuditLog;
```

`models/index.ts`: import the ten models, add them to the `models` object and the named `export { … }` list, and append to `setupAssociations()`:
```ts
  // ── Billing ──
  BillingCustomer.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingSubscription.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingTransaction.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingTransaction.belongsTo(BillingSubscription, { foreignKey: 'subscriptionId', as: 'subscription', constraints: false });
  BillingPriceNotice.belongsTo(BillingSubscription, { foreignKey: 'subscriptionId', as: 'subscription', constraints: false });
```

- [ ] **Step 5: Write the integration test**

`server/src/modules/billing/__int__/models.int.test.ts`:
```ts
import { UniqueConstraintError } from 'sequelize';
import {
  setupAssociations, Household, BillingEvent, BillingTransaction, BillingSubscription, BillingCustomer,
} from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('billing schema', () => {
  it('defaults households to the live cohort', async () => {
    const { household } = await createHouseholdWithAdmin();
    const fresh = await Household.findByPk(household.id);
    expect(fresh!.billingCohort).toBe('live');
  });

  it('enforces unique provider_event_id', async () => {
    const row = { provider: 'stripe', livemode: false, providerEventId: 'evt_1', type: 'x', payload: {}, receivedAt: new Date() };
    await BillingEvent.create(row);
    await expect(BillingEvent.create(row)).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('enforces the ledger identity and allows the same object id across types', async () => {
    const base = {
      provider: 'stripe', livemode: false, status: 'paid', amount: 899, currency: 'usd',
      matchStatus: 'unmatched', providerObjectId: 'in_1', occurredAt: new Date(),
    };
    await BillingTransaction.create({ ...base, type: 'payment' });
    await BillingTransaction.create({ ...base, type: 'failed_payment' });
    await expect(BillingTransaction.create({ ...base, type: 'payment' })).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('enforces one customer per household, provider and mode', async () => {
    const { household } = await createHouseholdWithAdmin();
    await BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: false, providerCustomerId: 'cus_1' });
    await BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: true, providerCustomerId: 'cus_2' });
    await expect(BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: false, providerCustomerId: 'cus_3' }))
      .rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('stores subscriptions with JSON and nullable fields', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const sub = await BillingSubscription.create({
      householdId: household.id, provider: 'stripe', livemode: false, providerSubscriptionId: 'sub_1',
      status: 'active', interval: 'month', seats: 5, pendingUpdate: { expires_at: 1 }, purchasedByUserId: admin.id,
    });
    const fresh = await BillingSubscription.findByPk(sub.id);
    expect(fresh!.pendingUpdate).toEqual({ expires_at: 1 });
    expect(fresh!.cancelAtPeriodEnd).toBe(false);
  });
});
```

- [ ] **Step 6: Migrate and run**

```bash
cd server
npm run db:migrate
npm run test:int -- src/modules/billing/__int__/models.int.test.ts
npx jest src/database/__tests__/billingSeeds.test.ts
npm run type-check
```
Expected: migrations apply on `rootaroo_dev` (the int harness migrates `rootaroo_test` itself); tests PASS; type-check clean. Also check reversibility once on the test DB: `NODE_ENV=test DB_NAME=rootaroo_test npx sequelize-cli db:migrate:undo` four times, then `db:migrate` again; both directions succeed.

- [ ] **Step 7: Commit**

```bash
git add server/src/database server/src/modules/billing/__int__/models.int.test.ts
git commit -F - <<'MSG'
feat(billing): migrations and models for billing, ledger, reconciliation and audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 2 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && npx jest --coverage --collectCoverageFrom='src/modules/billing/**/*.ts' src/modules/billing
cd server && NODE_ENV=development npx tsx -e "require('./src/modules/billing/config').assertBillingConfigAtStartup(); console.log('billing config OK')"
```
Acceptance:
- All suites green versus baseline; no lint errors in `src/modules/billing` or the touched shared files.
- Migrations applied to `rootaroo_dev` and `rootaroo_test`, and undo/redo works.
- The startup check prints `billing config OK` with the orchestrator's `server/.env` (test mode on).
- `git grep -nE "(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}" -- server` prints nothing.

---
## Wave 3: Catalog, bootstrap script and `GET /billing/plans` (§6)

### Task 3.1: Catalog, Stripe mock and fixtures

**Files:**
- Create: `server/src/modules/billing/catalog.ts`, `server/src/test/billing/stripeMock.ts`, `server/src/test/billing/fixtures.ts`
- Modify: `server/src/index.ts` (start the bust subscriber)
- Test: `server/src/modules/billing/__tests__/catalog.test.ts`

**Interfaces:**
- Consumes: `getStripe`, `__setStripeForTests`, `__setBillingConfigForTests`, `BillingConfig` (2.3); `publishMessage`, `CATALOG_BUST_CHANNEL` (2.4); `testBillingConfig` (2.3).
- Produces (`catalog.ts`):
  - `SEATS_INCLUDED = 5`, `SEATS_MAX = 10`, `SEAT_SIZES: readonly number[]` (5..10), `INTERVALS: readonly BillingInterval[]`
  - `interface PriceFormula { monthBase: number; monthExtra: number; yearBase: number; yearExtra: number }`, `LAUNCH_FORMULA`, `LAUNCH_PRICE_SET = '2026-10'`
  - `amountFor(formula: PriceFormula, interval: BillingInterval, seats: number): number`
  - `lookupKey(interval: BillingInterval, seats: number): string`, `assertSeats(seats: number): void`
  - `interface CatalogPrice { priceId: string; amount: number; currency: string; priceSet: string; seats: number; interval: BillingInterval; active: boolean; lookupKey: string | null }`
  - `interface Catalog { mode: BillingMode; priceSet: string; currency: string; prices: CatalogPrice[]; loadedAt: number }`
  - `toCatalogPrice(p: Stripe.Price): CatalogPrice | null`, `getCatalog(mode, now?): Promise<Catalog>`, `priceFor(catalog, interval, seats): CatalogPrice`, `findPriceInSet(mode, priceSet, interval, seats): Promise<CatalogPrice | null>`, `bustCatalogCache(mode?): Promise<void>`, `clearLocalCatalogCache(mode?): void`, `startCatalogBustSubscriber(): void`
- Produces (test helpers):
  - `type StripeMock` and `makeStripeMock(): StripeMock`, `installStripeMock(mode?: BillingMode, config?: BillingConfig): StripeMock`, `listOf<T>(items: T[])` (thenable + async-iterable list result)
  - fixtures: `stripePrice(o?)`, `catalogPrices(priceSet?, formula?)`, `stripeSubscription(o?)`, `stripeInvoice(o?)`, `stripeCheckoutSession(o?)`, `stripeRefund(o?)`, `stripeDispute(o?)`, `stripeEvent(type, object, o?)`

- [ ] **Step 1: Write the test helpers**

`server/src/test/billing/stripeMock.ts`:
```ts
import Stripe from 'stripe';
import { __setBillingConfigForTests, __setStripeForTests, BillingConfig } from '../../modules/billing/config';
import type { BillingMode } from '../../modules/billing/types';
import { testBillingConfig } from './config';
import { fakeKey } from './secrets';

/** A Stripe list result that works with `await`, `for await` and autoPagingToArray. */
export function listOf<T>(items: T[]): any {
  const page = { object: 'list', data: items, has_more: false };
  const p: any = Promise.resolve(page);
  p[Symbol.asyncIterator] = async function* () { yield* items; };
  p.autoPagingToArray = async () => items;
  p.autoPagingEach = async (fn: (x: T) => unknown) => { for (const i of items) await fn(i); };
  return p;
}

const fn = () => jest.fn();
const listFn = () => jest.fn(() => listOf([]));

export function makeStripeMock() {
  // Real webhook helpers (pure crypto, no network) so signature tests are genuine.
  const real = new Stripe(fakeKey('sk_test'));
  return {
    customers: { create: fn(), retrieve: fn(), update: fn(), search: jest.fn(() => listOf([])) },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    subscriptions: { retrieve: fn(), list: listFn(), update: fn(), cancel: fn() },
    prices: { list: listFn(), create: fn(), update: fn() },
    products: { list: listFn(), create: fn(), update: fn() },
    billingPortal: { sessions: { create: fn() }, configurations: { list: listFn(), create: fn(), update: fn() } },
    invoices: { list: listFn(), retrieve: fn() },
    invoicePayments: { list: listFn() },
    paymentIntents: { retrieve: fn() },
    charges: { retrieve: fn() },
    refunds: { create: fn(), list: listFn() },
    disputes: { list: listFn(), update: fn() },
    webhookEndpoints: { list: listFn(), create: fn(), update: fn() },
    testHelpers: { testClocks: { create: fn(), advance: fn(), retrieve: fn() } },
    webhooks: real.webhooks,
  };
}

export type StripeMock = ReturnType<typeof makeStripeMock>;

export function installStripeMock(mode: BillingMode = 'test', config: BillingConfig = testBillingConfig()): StripeMock {
  __setBillingConfigForTests(config);
  const mock = makeStripeMock();
  __setStripeForTests(mode, mock);
  return mock;
}
```

`server/src/test/billing/fixtures.ts`:
```ts
import Stripe from 'stripe';
import { LAUNCH_FORMULA, LAUNCH_PRICE_SET, PriceFormula, amountFor, lookupKey, SEAT_SIZES, INTERVALS } from '../../modules/billing/catalog';
import type { BillingInterval } from '../../modules/billing/types';

let n = 0;
const nextId = (prefix: string) => `${prefix}_${String(++n).padStart(8, '0')}`;
const nowSec = () => Math.floor(Date.now() / 1000);

export function stripePrice(o: Partial<{ id: string; seats: number; interval: BillingInterval; priceSet: string; amount: number; active: boolean; lookupKey: string | null }> = {}): Stripe.Price {
  const seats = o.seats ?? 5;
  const interval = o.interval ?? 'month';
  return {
    id: o.id ?? nextId('price'),
    object: 'price',
    active: o.active ?? true,
    currency: 'usd',
    unit_amount: o.amount ?? amountFor(LAUNCH_FORMULA, interval, seats),
    recurring: { interval, interval_count: 1 },
    lookup_key: o.lookupKey === undefined ? lookupKey(interval, seats) : o.lookupKey,
    metadata: { price_set: o.priceSet ?? LAUNCH_PRICE_SET, seats: String(seats), interval },
    product: `prod_hh${seats}`,
    livemode: false,
  } as unknown as Stripe.Price;
}

export function catalogPrices(priceSet = LAUNCH_PRICE_SET, formula: PriceFormula = LAUNCH_FORMULA): Stripe.Price[] {
  return INTERVALS.flatMap((interval) => SEAT_SIZES.map((seats) => stripePrice({
    id: `price_${priceSet.replace('-', '')}_${seats}_${interval}`, seats, interval, priceSet, amount: amountFor(formula, interval, seats),
  })));
}

export function stripeInvoice(o: Partial<{
  id: string; customer: string; subscriptionId: string | null; subscriptionEnv: string; status: Stripe.Invoice.Status;
  billingReason: string; amountPaid: number; amountDue: number; created: number; finalizedAt: number | null; paidAt: number | null;
  hostedInvoiceUrl: string; livemode: boolean; customerEmail: string | null; attempted: boolean;
}> = {}): Stripe.Invoice {
  const created = o.created ?? nowSec();
  const subId = o.subscriptionId === undefined ? 'sub_default' : o.subscriptionId;
  return {
    id: o.id ?? nextId('in'),
    object: 'invoice',
    customer: o.customer ?? 'cus_default',
    customer_email: o.customerEmail === undefined ? 'payer@example.test' : o.customerEmail,
    status: o.status ?? 'paid',
    billing_reason: o.billingReason ?? 'subscription_create',
    amount_paid: o.amountPaid ?? 899,
    amount_due: o.amountDue ?? 899,
    currency: 'usd',
    created,
    attempted: o.attempted ?? true,
    livemode: o.livemode ?? false,
    hosted_invoice_url: o.hostedInvoiceUrl ?? 'https://invoice.stripe.com/i/test',
    status_transitions: { finalized_at: o.finalizedAt === undefined ? created : o.finalizedAt, paid_at: o.paidAt === undefined ? created : o.paidAt },
    parent: subId ? { type: 'subscription_details', subscription_details: { subscription: subId, metadata: { env: o.subscriptionEnv ?? 'dev' } } } : null,
    lines: { data: [{ description: '1 × Rootaroo Household: 5 members' }] },
  } as unknown as Stripe.Invoice;
}

export function stripeSubscription(o: Partial<{
  id: string; customer: string; status: Stripe.Subscription.Status; seats: number; interval: BillingInterval; priceSet: string;
  amount: number; priceId: string; householdId: string; purchasedByUserId: string; env: string; created: number;
  periodStart: number; periodEnd: number; cancelAtPeriodEnd: boolean; canceledAt: number | null; endedAt: number | null;
  latestInvoice: Stripe.Invoice | string | null; pendingUpdate: Record<string, unknown> | null; livemode: boolean; itemId: string;
}> = {}): Stripe.Subscription {
  const seats = o.seats ?? 5;
  const interval = o.interval ?? 'month';
  const start = o.periodStart ?? nowSec();
  const end = o.periodEnd ?? start + (interval === 'month' ? 30 : 365) * 86400;
  const price = stripePrice({ id: o.priceId, seats, interval, priceSet: o.priceSet, amount: o.amount });
  return {
    id: o.id ?? nextId('sub'),
    object: 'subscription',
    customer: o.customer ?? 'cus_default',
    status: o.status ?? 'active',
    created: o.created ?? start,
    livemode: o.livemode ?? false,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.canceledAt ?? null,
    ended_at: o.endedAt ?? null,
    pending_update: o.pendingUpdate ?? null,
    latest_invoice: o.latestInvoice === undefined ? stripeInvoice({ customer: o.customer, created: start }) : o.latestInvoice,
    metadata: {
      ...(o.householdId ? { householdId: o.householdId } : {}),
      ...(o.purchasedByUserId ? { purchasedByUserId: o.purchasedByUserId } : {}),
      env: o.env ?? 'dev',
    },
    items: { object: 'list', data: [{ id: o.itemId ?? nextId('si'), price, quantity: 1, current_period_start: start, current_period_end: end }] },
  } as unknown as Stripe.Subscription;
}

export function stripeCheckoutSession(o: Partial<{
  id: string; status: Stripe.Checkout.Session.Status; paymentStatus: Stripe.Checkout.Session.PaymentStatus; customer: string;
  clientReferenceId: string; subscription: string | Stripe.Subscription | null; url: string; livemode: boolean; env: string;
}> = {}): Stripe.Checkout.Session {
  const livemode = o.livemode ?? false;
  return {
    id: o.id ?? `cs_${livemode ? 'live' : 'test'}_${String(++n).padStart(10, '0')}`,
    object: 'checkout.session',
    status: o.status ?? 'open',
    payment_status: o.paymentStatus ?? 'unpaid',
    customer: o.customer ?? 'cus_default',
    client_reference_id: o.clientReferenceId ?? null,
    subscription: o.subscription ?? null,
    url: o.url ?? 'https://checkout.stripe.com/c/pay/test',
    livemode,
    metadata: { env: o.env ?? 'dev' },
  } as unknown as Stripe.Checkout.Session;
}

export function stripeRefund(o: Partial<{ id: string; amount: number; status: string; paymentIntent: string | null; charge: string | null; created: number }> = {}): Stripe.Refund {
  return {
    id: o.id ?? nextId('re'), object: 'refund', amount: o.amount ?? 899, currency: 'usd', status: o.status ?? 'succeeded',
    payment_intent: o.paymentIntent === undefined ? 'pi_default' : o.paymentIntent,
    charge: o.charge === undefined ? 'ch_default' : o.charge, created: o.created ?? nowSec(), metadata: {},
  } as unknown as Stripe.Refund;
}

export function stripeDispute(o: Partial<{
  id: string; amount: number; status: Stripe.Dispute.Status; paymentIntent: string | null; charge: string; created: number;
  balanceTransactions: Array<{ amount: number; fee: number }>;
}> = {}): Stripe.Dispute {
  return {
    id: o.id ?? nextId('dp'), object: 'dispute', amount: o.amount ?? 899, currency: 'usd', status: o.status ?? 'needs_response',
    payment_intent: o.paymentIntent === undefined ? 'pi_default' : o.paymentIntent, charge: o.charge ?? 'ch_default',
    created: o.created ?? nowSec(), reason: 'fraudulent',
    balance_transactions: (o.balanceTransactions ?? []).map((bt, i) => ({ id: `txn_${i}`, ...bt })),
  } as unknown as Stripe.Dispute;
}

export function stripeEvent(type: string, object: unknown, o: Partial<{ id: string; livemode: boolean; created: number }> = {}): Stripe.Event {
  return {
    id: o.id ?? nextId('evt'), object: 'event', type, livemode: o.livemode ?? false, created: o.created ?? nowSec(),
    api_version: '2026-09-30.endive', data: { object }, pending_webhooks: 1, request: { id: null, idempotency_key: null },
  } as unknown as Stripe.Event;
}
```

- [ ] **Step 2: Write the failing catalog tests**

`server/src/modules/billing/__tests__/catalog.test.ts`:
```ts
const redisMock: any = { status: 'end', publish: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

import {
  amountFor, lookupKey, LAUNCH_FORMULA, getCatalog, priceFor, findPriceInSet, bustCatalogCache, clearLocalCatalogCache,
  toCatalogPrice, assertSeats,
} from '../catalog';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice } from '../../../test/billing/fixtures';

let stripe: StripeMock;
beforeEach(() => {
  clearLocalCatalogCache();
  stripe = installStripeMock('test');
  const all = catalogPrices();
  stripe.prices.list.mockImplementation((p: { lookup_keys?: string[] }) =>
    listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys!.includes(x.lookup_key!)) : all));
});

describe('price formulas (§6.1, all 12 amounts)', () => {
  it.each([
    [5, 899, 7999], [6, 1098, 10387], [7, 1297, 12775], [8, 1496, 15163], [9, 1695, 17551], [10, 1894, 19939],
  ])('%i members -> %i / %i', (seats, month, year) => {
    expect(amountFor(LAUNCH_FORMULA, 'month', seats)).toBe(month);
    expect(amountFor(LAUNCH_FORMULA, 'year', seats)).toBe(year);
  });

  it('rejects sizes outside 5..10', () => {
    expect(() => assertSeats(4)).toThrow();
    expect(() => assertSeats(11)).toThrow();
    expect(() => assertSeats(5.5)).toThrow();
  });

  it('builds lookup keys', () => {
    expect(lookupKey('year', 7)).toBe('rootaroo_hh7_year');
  });
});

describe('getCatalog', () => {
  it('loads both intervals by lookup key (max 10 per call) and caches for 10 minutes', async () => {
    const cat = await getCatalog('test', 1_000);
    expect(cat.priceSet).toBe('2026-10');
    expect(cat.prices).toHaveLength(12);
    expect(stripe.prices.list).toHaveBeenCalledTimes(2);
    for (const call of stripe.prices.list.mock.calls) expect((call[0] as any).lookup_keys.length).toBeLessThanOrEqual(10);
    await getCatalog('test', 1_000 + 9 * 60_000);
    expect(stripe.prices.list).toHaveBeenCalledTimes(2);
    await getCatalog('test', 1_000 + 11 * 60_000);
    expect(stripe.prices.list).toHaveBeenCalledTimes(4);
  });

  it('busting clears the cache and publishes', async () => {
    await getCatalog('test');
    redisMock.status = 'ready';
    redisMock.publish.mockResolvedValue(1);
    await bustCatalogCache('test');
    expect(redisMock.publish).toHaveBeenCalledWith('billing:catalog:bust', 'test');
    await getCatalog('test');
    expect(stripe.prices.list).toHaveBeenCalledTimes(4);
    redisMock.status = 'end';
  });

  it('refuses an incomplete catalog with 503 CATALOG_UNAVAILABLE', async () => {
    stripe.prices.list.mockImplementation(() => listOf(catalogPrices().slice(0, 5)));
    await expect(getCatalog('test')).rejects.toMatchObject({ statusCode: 503, code: 'CATALOG_UNAVAILABLE' });
  });

  it('priceFor returns the matching price', async () => {
    const cat = await getCatalog('test');
    expect(priceFor(cat, 'year', 7)).toMatchObject({ amount: 12775, seats: 7, interval: 'year' });
  });
});

describe('findPriceInSet', () => {
  it('uses the catalog for the current set', async () => {
    const p = await findPriceInSet('test', '2026-10', 'month', 6);
    expect(p!.amount).toBe(1098);
  });

  it('finds an older set among all active prices (grandfathering)', async () => {
    const old = stripePrice({ id: 'price_old_6m', seats: 6, interval: 'month', priceSet: '2025-01', amount: 999, lookupKey: null });
    stripe.prices.list.mockImplementation((p: { lookup_keys?: string[] }) =>
      listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys!.includes(x.lookup_key!)) : [...catalogPrices(), old]));
    await expect(findPriceInSet('test', '2025-01', 'month', 6)).resolves.toMatchObject({ priceId: 'price_old_6m', amount: 999 });
    await expect(findPriceInSet('test', '2025-01', 'year', 6)).resolves.toBeNull();
  });
});

describe('toCatalogPrice', () => {
  it('rejects prices without valid metadata', () => {
    const bad = stripePrice();
    (bad as any).metadata = { seats: 'eleven' };
    expect(toCatalogPrice(bad)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npx jest src/modules/billing/__tests__/catalog.test.ts`
Expected: FAIL, `../catalog` not found.

- [ ] **Step 4: Implement `catalog.ts`**

```ts
import Stripe from 'stripe';
import redis from '../../config/redis';
import logger from '../../shared/utils/logger';
import { AppError, ValidationError } from '../../shared/utils/errors';
import { getStripe } from './config';
import { CATALOG_BUST_CHANNEL, publishMessage } from './cache';
import type { BillingInterval, BillingMode } from './types';

export const SEATS_INCLUDED = 5;
export const SEATS_MAX = 10;
export const SEAT_SIZES: readonly number[] = [5, 6, 7, 8, 9, 10];
export const INTERVALS: readonly BillingInterval[] = ['month', 'year'];

export interface PriceFormula { monthBase: number; monthExtra: number; yearBase: number; yearExtra: number }
export const LAUNCH_FORMULA: PriceFormula = { monthBase: 899, monthExtra: 199, yearBase: 7999, yearExtra: 2388 };
export const LAUNCH_PRICE_SET = '2026-10';

const TTL_MS = 10 * 60_000;

export interface CatalogPrice {
  priceId: string;
  amount: number;
  currency: string;
  priceSet: string;
  seats: number;
  interval: BillingInterval;
  active: boolean;
  lookupKey: string | null;
}

export interface Catalog { mode: BillingMode; priceSet: string; currency: string; prices: CatalogPrice[]; loadedAt: number }

export function assertSeats(seats: number): void {
  if (!Number.isInteger(seats) || seats < SEATS_INCLUDED || seats > SEATS_MAX) {
    throw new ValidationError(`seats must be an integer from ${SEATS_INCLUDED} to ${SEATS_MAX}`);
  }
}

export function amountFor(f: PriceFormula, interval: BillingInterval, seats: number): number {
  assertSeats(seats);
  const extra = seats - SEATS_INCLUDED;
  return interval === 'month' ? f.monthBase + f.monthExtra * extra : f.yearBase + f.yearExtra * extra;
}

export function lookupKey(interval: BillingInterval, seats: number): string {
  return `rootaroo_hh${seats}_${interval}`;
}

export function toCatalogPrice(p: Stripe.Price): CatalogPrice | null {
  const seats = Number(p.metadata?.seats);
  const interval = p.recurring?.interval;
  const priceSet = p.metadata?.price_set;
  if (!Number.isInteger(seats) || seats < SEATS_INCLUDED || seats > SEATS_MAX) return null;
  if (interval !== 'month' && interval !== 'year') return null;
  if (!priceSet || typeof p.unit_amount !== 'number') return null;
  return {
    priceId: p.id, amount: p.unit_amount, currency: p.currency, priceSet, seats, interval,
    active: p.active, lookupKey: p.lookup_key ?? null,
  };
}

const catalogCache = new Map<BillingMode, { value: Catalog; expires: number }>();
const allPricesCache = new Map<BillingMode, { value: CatalogPrice[]; expires: number }>();

export function clearLocalCatalogCache(mode?: BillingMode): void {
  if (mode) { catalogCache.delete(mode); allPricesCache.delete(mode); return; }
  catalogCache.clear();
  allPricesCache.clear();
}

export async function getCatalog(mode: BillingMode, now: number = Date.now()): Promise<Catalog> {
  const hit = catalogCache.get(mode);
  if (hit && hit.expires > now) return hit.value;
  const stripe = getStripe(mode);
  // Verify at implementation time: lookup_keys accepts at most 10 values
  // (https://docs.stripe.com/api/prices/list.md), hence one call per interval.
  const pages = await Promise.all(INTERVALS.map((interval) =>
    stripe.prices.list({ lookup_keys: SEAT_SIZES.map((s) => lookupKey(interval, s)), active: true, limit: 10 })));
  const prices = pages.flatMap((pg) => pg.data).map(toCatalogPrice).filter((p): p is CatalogPrice => p !== null);
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      if (!prices.some((p) => p.interval === interval && p.seats === seats)) {
        throw new AppError(503, `Price catalog is incomplete (${lookupKey(interval, seats)} missing)`, 'CATALOG_UNAVAILABLE');
      }
    }
  }
  const base = prices.find((p) => p.interval === 'month' && p.seats === SEATS_INCLUDED)!;
  const value: Catalog = { mode, priceSet: base.priceSet, currency: base.currency, prices, loadedAt: now };
  catalogCache.set(mode, { value, expires: now + TTL_MS });
  return value;
}

export function priceFor(catalog: Catalog, interval: BillingInterval, seats: number): CatalogPrice {
  assertSeats(seats);
  const p = catalog.prices.find((x) => x.interval === interval && x.seats === seats);
  if (!p) throw new AppError(503, 'Price not available', 'CATALOG_UNAVAILABLE');
  return p;
}

async function allActivePrices(mode: BillingMode, now = Date.now()): Promise<CatalogPrice[]> {
  const hit = allPricesCache.get(mode);
  if (hit && hit.expires > now) return hit.value;
  const raw = await getStripe(mode).prices.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 2000 });
  const value = raw.map(toCatalogPrice).filter((p): p is CatalogPrice => p !== null);
  allPricesCache.set(mode, { value, expires: now + TTL_MS });
  return value;
}

/** §6.5 grandfathering: an active price from a specific price_set, or null. */
export async function findPriceInSet(mode: BillingMode, priceSet: string, interval: BillingInterval, seats: number): Promise<CatalogPrice | null> {
  assertSeats(seats);
  const catalog = await getCatalog(mode);
  if (catalog.priceSet === priceSet) return priceFor(catalog, interval, seats);
  const all = await allActivePrices(mode);
  return all.find((p) => p.priceSet === priceSet && p.interval === interval && p.seats === seats && p.active) ?? null;
}

export async function bustCatalogCache(mode?: BillingMode): Promise<void> {
  clearLocalCatalogCache(mode);
  const sent = await publishMessage(CATALOG_BUST_CHANNEL, mode ?? 'all');
  if (!sent) logger.warn('[Billing] Catalog bust not published (Redis down); other instances refresh within 10 minutes');
}

export function startCatalogBustSubscriber(): void {
  const sub = redis.duplicate();
  sub.on('error', () => undefined);
  sub.subscribe(CATALOG_BUST_CHANNEL).catch((err: Error) => logger.warn(`[Billing] catalog subscriber: ${err.message}`));
  sub.on('message', (_channel: string, message: string) => {
    clearLocalCatalogCache(message === 'test' || message === 'live' ? message : undefined);
  });
}
```
In `server/src/index.ts`, after `assertBillingConfigAtStartup();` add `startCatalogBustSubscriber();` (import from `./modules/billing/catalog`).

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npx jest src/modules/billing/__tests__/catalog.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing/catalog.ts server/src/modules/billing/__tests__/catalog.test.ts server/src/test/billing server/src/index.ts
git commit -F - <<'MSG'
feat(billing): price catalog with lookup keys, grandfathering and cache bust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 3.2: `stripe-bootstrap.ts` (catalog, portal, webhook endpoints, `--set-prices`)

**Files:**
- Create: `server/src/modules/billing/scripts/stripe-bootstrap.ts`, `docs/superpowers/evidence/w3-bootstrap.md`
- Modify: `server/package.json` (script `"billing:bootstrap": "tsx src/modules/billing/scripts/stripe-bootstrap.ts"`)
- Test: `server/src/modules/billing/__tests__/bootstrap.test.ts`

**Interfaces:**
- Consumes: `LAUNCH_FORMULA`, `LAUNCH_PRICE_SET`, `PriceFormula`, `amountFor`, `lookupKey`, `SEAT_SIZES`, `INTERVALS`, `bustCatalogCache` (3.1); `STRIPE_API_VERSION` (2.3).
- Produces:
  - `interface BootstrapOptions { mode: BillingMode; confirmLive: boolean; skipWebhooks: boolean; setPrices: { priceSet: string; formula: PriceFormula } | null; migratePrices: { from: string; to: string; noticeDays: number } | null; backfill: boolean }`
  - `parseArgs(argv: string[]): BootstrapOptions`
  - `WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[]` (exactly §8.5's list)
  - `ensureProducts(stripe: Stripe): Promise<Map<number, string>>` (seats → product id)
  - `ensurePrices(stripe, products, priceSet, formula, transfer: boolean): Promise<Array<{ key: string; action: 'created'|'exists' }>>`
  - `ensurePortalConfiguration(stripe, returnUrl: string): Promise<{ id: string; action: 'created'|'updated' }>`
  - `ensureWebhookEndpoint(stripe, mode, baseUrl): Promise<{ id: string; action: 'created'|'updated'|'skipped' }>`
  - `PORTAL_METADATA = { rootaroo_portal: 'v1' }`
  - `main(argv: string[]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/bootstrap.test.ts`:
```ts
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end', disconnect: jest.fn() } }));

import {
  parseArgs, ensureProducts, ensurePrices, ensurePortalConfiguration, ensureWebhookEndpoint, WEBHOOK_EVENTS,
} from '../scripts/stripe-bootstrap';
import { makeStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice } from '../../../test/billing/fixtures';
import { LAUNCH_FORMULA } from '../catalog';

const asStripe = (m: unknown) => m as any;

describe('parseArgs', () => {
  it('requires --confirm-live for live', () => {
    expect(() => parseArgs(['--mode', 'live'])).toThrow(/--confirm-live/);
    expect(parseArgs(['--mode', 'live', '--confirm-live']).mode).toBe('live');
  });

  it('parses --set-prices with all four amounts', () => {
    const o = parseArgs(['--mode', 'test', '--set-prices', '2027-01', '--month-base', '999', '--month-extra', '249', '--year-base', '8999', '--year-extra', '2988']);
    expect(o.setPrices).toEqual({ priceSet: '2027-01', formula: { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 } });
  });

  it('rejects --set-prices with missing or non-integer amounts', () => {
    expect(() => parseArgs(['--mode', 'test', '--set-prices', '2027-01', '--month-base', '9.99'])).toThrow();
  });

  it('rejects unknown modes and malformed price sets', () => {
    expect(() => parseArgs(['--mode', 'prod'])).toThrow();
    expect(() => parseArgs(['--mode', 'test', '--set-prices', 'jan', '--month-base', '1', '--month-extra', '1', '--year-base', '1', '--year-extra', '1'])).toThrow(/price set/);
  });
});

describe('ensureProducts', () => {
  it('creates missing products and reuses existing ones', async () => {
    const s = makeStripeMock();
    s.products.list.mockReturnValue(listOf([{ id: 'prod_5', metadata: { rootaroo_catalog: 'household', seats: '5' } }]));
    s.products.create.mockImplementation(async (p: any) => ({ id: `prod_${p.metadata.seats}` }));
    const map = await ensureProducts(asStripe(s));
    expect(map.get(5)).toBe('prod_5');
    expect(s.products.create).toHaveBeenCalledTimes(5);
    expect(s.products.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rootaroo Household: 7 members', metadata: { rootaroo_catalog: 'household', seats: '7' } }));
  });
});

describe('ensurePrices', () => {
  const products = new Map([5, 6, 7, 8, 9, 10].map((n) => [n, `prod_${n}`]));

  it('creates all 12 launch prices with metadata, lookup keys and exclusive tax', async () => {
    const s = makeStripeMock();
    s.prices.list.mockReturnValue(listOf([]));
    s.prices.create.mockResolvedValue({ id: 'price_x' });
    const res = await ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false);
    expect(res.filter((r) => r.action === 'created')).toHaveLength(12);
    expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      product: 'prod_7', unit_amount: 12775, currency: 'usd', recurring: { interval: 'year' },
      lookup_key: 'rootaroo_hh7_year', tax_behavior: 'exclusive',
      metadata: { price_set: '2026-10', seats: '7', interval: 'year' },
    }));
    expect(s.prices.create.mock.calls[0][0]).not.toHaveProperty('transfer_lookup_key');
  });

  it('is idempotent when every lookup key already points at the same set and amount', async () => {
    const s = makeStripeMock();
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    const res = await ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false);
    expect(res.every((r) => r.action === 'exists')).toBe(true);
    expect(s.prices.create).not.toHaveBeenCalled();
  });

  it('refuses to silently change an existing amount without --set-prices', async () => {
    const s = makeStripeMock();
    s.prices.list.mockReturnValue(listOf([stripePrice({ seats: 5, interval: 'month', amount: 100 })]));
    await expect(ensurePrices(asStripe(s), products, '2026-10', LAUNCH_FORMULA, false)).rejects.toThrow(/--set-prices/);
  });

  it('--set-prices transfers lookup keys to a new set', async () => {
    const s = makeStripeMock();
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    s.prices.create.mockResolvedValue({ id: 'price_new' });
    const f = { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 };
    await ensurePrices(asStripe(s), products, '2027-01', f, true);
    expect(s.prices.create).toHaveBeenCalledTimes(12);
    expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      lookup_key: 'rootaroo_hh5_month', transfer_lookup_key: true, unit_amount: 999, metadata: expect.objectContaining({ price_set: '2027-01' }),
    }));
  });
});

describe('ensurePortalConfiguration', () => {
  it('creates a configuration with plan switching off and end-of-period cancel', async () => {
    const s = makeStripeMock();
    s.billingPortal.configurations.list.mockReturnValue(listOf([]));
    s.billingPortal.configurations.create.mockResolvedValue({ id: 'bpc_1' });
    await expect(ensurePortalConfiguration(asStripe(s), 'https://x/api/v1/billing/return/portal')).resolves.toEqual({ id: 'bpc_1', action: 'created' });
    const params = s.billingPortal.configurations.create.mock.calls[0][0] as any;
    expect(params.features.subscription_update.enabled).toBe(false);
    expect(params.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true } });
    expect(params.features.payment_method_update.enabled).toBe(true);
    expect(params.features.invoice_history.enabled).toBe(true);
    expect(params.metadata).toEqual({ rootaroo_portal: 'v1' });
  });

  it('updates the existing tagged configuration', async () => {
    const s = makeStripeMock();
    s.billingPortal.configurations.list.mockReturnValue(listOf([{ id: 'bpc_9', metadata: { rootaroo_portal: 'v1' } }]));
    s.billingPortal.configurations.update.mockResolvedValue({ id: 'bpc_9' });
    await expect(ensurePortalConfiguration(asStripe(s), 'https://x')).resolves.toEqual({ id: 'bpc_9', action: 'updated' });
  });
});

describe('ensureWebhookEndpoint', () => {
  it('subscribes only to the §8.5 events, pinned to the API version', async () => {
    const s = makeStripeMock();
    s.webhookEndpoints.list.mockReturnValue(listOf([]));
    s.webhookEndpoints.create.mockResolvedValue({ id: 'we_1' });
    await ensureWebhookEndpoint(asStripe(s), 'test', 'https://api.example.test');
    expect(s.webhookEndpoints.create).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example.test/api/v1/billing/webhooks/stripe/test',
      enabled_events: WEBHOOK_EVENTS, api_version: '2026-09-30.endive',
    }));
    expect(WEBHOOK_EVENTS).toHaveLength(22);
  });

  it('updates an existing endpoint with the same URL', async () => {
    const s = makeStripeMock();
    s.webhookEndpoints.list.mockReturnValue(listOf([{ id: 'we_2', url: 'https://api.example.test/api/v1/billing/webhooks/stripe/test' }]));
    s.webhookEndpoints.update.mockResolvedValue({ id: 'we_2' });
    await expect(ensureWebhookEndpoint(asStripe(s), 'test', 'https://api.example.test')).resolves.toEqual({ id: 'we_2', action: 'updated' });
  });

  it('skips non-https bases (local dev uses stripe listen)', async () => {
    const s = makeStripeMock();
    await expect(ensureWebhookEndpoint(asStripe(s), 'test', 'http://localhost:3000')).resolves.toEqual({ id: '', action: 'skipped' });
    expect(s.webhookEndpoints.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/modules/billing/__tests__/bootstrap.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the script**

`server/src/modules/billing/scripts/stripe-bootstrap.ts`:
```ts
/* eslint-disable no-console */
import path from 'path';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../config';
import {
  INTERVALS, LAUNCH_FORMULA, LAUNCH_PRICE_SET, PriceFormula, SEAT_SIZES, amountFor, bustCatalogCache, lookupKey,
} from '../catalog';
import type { BillingMode } from '../types';

export interface BootstrapOptions {
  mode: BillingMode;
  confirmLive: boolean;
  skipWebhooks: boolean;
  setPrices: { priceSet: string; formula: PriceFormula } | null;
  migratePrices: { from: string; to: string; noticeDays: number } | null;
  backfill: boolean;
}

export const PORTAL_METADATA = { rootaroo_portal: 'v1' };

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.pending_update_applied', 'customer.subscription.pending_update_expired',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required',
  'refund.created', 'refund.updated', 'refund.failed',
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated',
  'radar.early_fraud_warning.created', 'customer.updated',
];

const PRICE_SET_RE = /^\d{4}-\d{2}$/;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function intFlag(argv: string[], name: string): number {
  const raw = flag(argv, name);
  const v = Number(raw);
  if (raw === undefined || !Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer number of cents`);
  return v;
}

export function parseArgs(argv: string[]): BootstrapOptions {
  const mode = flag(argv, '--mode');
  if (mode !== 'test' && mode !== 'live') throw new Error('--mode must be test or live');
  const confirmLive = argv.includes('--confirm-live');
  if (mode === 'live' && !confirmLive) throw new Error('live mode requires --confirm-live');

  let setPrices: BootstrapOptions['setPrices'] = null;
  const set = flag(argv, '--set-prices');
  if (set !== undefined) {
    if (!PRICE_SET_RE.test(set)) throw new Error('price set must look like YYYY-MM');
    setPrices = {
      priceSet: set,
      formula: {
        monthBase: intFlag(argv, '--month-base'), monthExtra: intFlag(argv, '--month-extra'),
        yearBase: intFlag(argv, '--year-base'), yearExtra: intFlag(argv, '--year-extra'),
      },
    };
  }

  let migratePrices: BootstrapOptions['migratePrices'] = null;
  if (argv.includes('--migrate-prices')) {
    const from = flag(argv, '--from');
    const to = flag(argv, '--to');
    if (!from || !to || !PRICE_SET_RE.test(from) || !PRICE_SET_RE.test(to)) throw new Error('--migrate-prices needs --from YYYY-MM --to YYYY-MM');
    const noticeDays = Number(flag(argv, '--notice-days') ?? '30');
    if (!Number.isInteger(noticeDays) || noticeDays < 30) throw new Error('--notice-days must be an integer >= 30');
    migratePrices = { from, to, noticeDays };
  }

  return { mode, confirmLive, skipWebhooks: argv.includes('--skip-webhooks'), setPrices, migratePrices, backfill: argv.includes('--backfill') };
}

export async function ensureProducts(stripe: Stripe): Promise<Map<number, string>> {
  const existing = await stripe.products.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 1000 });
  const map = new Map<number, string>();
  for (const p of existing) {
    if (p.metadata?.rootaroo_catalog === 'household') map.set(Number(p.metadata.seats), p.id);
  }
  for (const seats of SEAT_SIZES) {
    if (map.has(seats)) continue;
    const created = await stripe.products.create(
      { name: `Rootaroo Household: ${seats} members`, metadata: { rootaroo_catalog: 'household', seats: String(seats) } },
      { idempotencyKey: `bootstrap:product:hh${seats}` },
    );
    map.set(seats, created.id);
  }
  return map;
}

export async function ensurePrices(
  stripe: Stripe, products: Map<number, string>, priceSet: string, formula: PriceFormula, transfer: boolean,
): Promise<Array<{ key: string; action: 'created' | 'exists' }>> {
  const out: Array<{ key: string; action: 'created' | 'exists' }> = [];
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      const key = lookupKey(interval, seats);
      const amount = amountFor(formula, interval, seats);
      const current = (await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })).data[0];
      if (current && current.metadata?.price_set === priceSet && current.unit_amount === amount) {
        out.push({ key, action: 'exists' });
        continue;
      }
      if (current && !transfer) {
        throw new Error(`${key} already points at ${current.id} (${current.unit_amount}, set ${current.metadata?.price_set}). Use --set-prices to move it.`);
      }
      const product = products.get(seats);
      if (!product) throw new Error(`product for ${seats} seats missing`);
      await stripe.prices.create({
        product, currency: 'usd', unit_amount: amount, recurring: { interval },
        lookup_key: key, tax_behavior: 'exclusive', nickname: `${key} ${priceSet}`,
        metadata: { price_set: priceSet, seats: String(seats), interval },
        ...(transfer ? { transfer_lookup_key: true } : {}),
      }, { idempotencyKey: `bootstrap:price:${priceSet}:${key}:${amount}` });
      out.push({ key, action: 'created' });
    }
  }
  return out;
}

export async function ensurePortalConfiguration(stripe: Stripe, returnUrl: string): Promise<{ id: string; action: 'created' | 'updated' }> {
  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: false },
    subscription_update: { enabled: false },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: {
        enabled: true,
        options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'],
      },
    },
  };
  const configs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 500 });
  const mine = configs.find((c) => c.metadata?.rootaroo_portal === PORTAL_METADATA.rootaroo_portal);
  if (mine) {
    await stripe.billingPortal.configurations.update(mine.id, { features, default_return_url: returnUrl });
    return { id: mine.id, action: 'updated' };
  }
  const created = await stripe.billingPortal.configurations.create({
    features, default_return_url: returnUrl, metadata: PORTAL_METADATA,
    business_profile: { headline: 'Manage your Rootaroo subscription' },
  });
  return { id: created.id, action: 'created' };
}

export async function ensureWebhookEndpoint(
  stripe: Stripe, mode: BillingMode, baseUrl: string,
): Promise<{ id: string; action: 'created' | 'updated' | 'skipped' }> {
  if (!baseUrl.startsWith('https://')) return { id: '', action: 'skipped' };
  const url = `${baseUrl}/api/v1/billing/webhooks/stripe/${mode}`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 }).autoPagingToArray({ limit: 500 });
  const existing = endpoints.find((e) => e.url === url);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    return { id: existing.id, action: 'updated' };
  }
  const created = await stripe.webhookEndpoints.create({
    url, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_API_VERSION,
    description: `Rootaroo ${mode} billing`, metadata: { rootaroo: 'v1' },
  });
  return { id: created.id, action: 'created' };
}

function bootstrapKey(mode: BillingMode): string {
  const key = mode === 'test'
    ? process.env.STRIPE_BOOTSTRAP_TEST_KEY || process.env.STRIPE_TEST_SECRET_KEY || ''
    : process.env.STRIPE_BOOTSTRAP_LIVE_KEY || process.env.STRIPE_LIVE_SECRET_KEY || '';
  const re = mode === 'test' ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/;
  if (!re.test(key)) throw new Error(`no ${mode} key configured (STRIPE_BOOTSTRAP_${mode.toUpperCase()}_KEY or the runtime key)`);
  return key;
}

export async function main(argv: string[]): Promise<void> {
  dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
  const opts = parseArgs(argv);
  const stripe = new Stripe(bootstrapKey(opts.mode), { apiVersion: STRIPE_API_VERSION });
  const base = (process.env.BILLING_PUBLIC_BASE_URL || process.env.SERVER_BASE_URL || '').replace(/\/+$/, '');

  const products = await ensureProducts(stripe);
  console.log(`products: ${[...products.entries()].map(([s, id]) => `${s}=${id}`).join(' ')}`);

  if (opts.setPrices) {
    const res = await ensurePrices(stripe, products, opts.setPrices.priceSet, opts.setPrices.formula, true);
    console.log(`set-prices ${opts.setPrices.priceSet}: ${res.filter((r) => r.action === 'created').length} created`);
  } else {
    const res = await ensurePrices(stripe, products, LAUNCH_PRICE_SET, LAUNCH_FORMULA, false);
    console.log(`prices: ${res.map((r) => `${r.key}:${r.action}`).join(' ')}`);
  }
  await bustCatalogCache(opts.mode);

  const portal = await ensurePortalConfiguration(stripe, `${base}/api/v1/billing/return/portal`);
  console.log(`portal configuration ${portal.id}: ${portal.action}`);

  if (!opts.skipWebhooks) {
    const wh = await ensureWebhookEndpoint(stripe, opts.mode, base);
    if (wh.action === 'skipped') console.log('webhook endpoint skipped (base URL is not https); use `stripe listen` locally');
    else console.log(`webhook endpoint ${wh.id}: ${wh.action}. Reveal its signing secret in the Dashboard and add it to STRIPE_${opts.mode.toUpperCase()}_WEBHOOK_SECRETS.`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async () => { (await import('../../../config/redis')).default.disconnect(); })
    .catch(async (err) => {
      console.error(`bootstrap failed: ${err.message}`);
      (await import('../../../config/redis')).default.disconnect();
      process.exit(1);
    });
}
```
Verify at implementation time: portal configuration feature fields (`https://docs.stripe.com/api/customer_portal/configurations/create.md`) and webhook endpoint `api_version` param (`https://docs.stripe.com/api/webhook_endpoints/create.md`). The `--migrate-prices` and `--backfill` branches are added to `main` in Tasks 7.4 and 7.2; `parseArgs` already accepts them.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/modules/billing/__tests__/bootstrap.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Run it against the dev sandbox (twice)**

First ask the orchestrator to confirm, in the dev sandbox Dashboard, that **Settings → Public details** has the Terms of Service URL set (required by `consent_collection.terms_of_service` in Task 5.5). Then:
```bash
cd server
npm run billing:bootstrap -- --mode test --skip-webhooks
npm run billing:bootstrap -- --mode test --skip-webhooks
```
Expected: first run creates 6 products, 12 prices and the portal configuration; the second run prints `exists` for all 12 keys and `updated` for the portal. Record both outputs (no keys appear in them) in `docs/superpowers/evidence/w3-bootstrap.md`, plus a `stripe prices list --api-key "$STRIPE_TEST_SECRET_KEY" --lookup-keys rootaroo_hh7_year` excerpt showing amount 12775 and metadata.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing/scripts server/src/modules/billing/__tests__/bootstrap.test.ts server/package.json docs/superpowers/evidence/w3-bootstrap.md
git commit -F - <<'MSG'
feat(billing): idempotent Stripe bootstrap for catalog, portal and webhooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 3.3: Caller context, plans and the billing router (§6.2)

**Files:**
- Create: `server/src/modules/billing/context.ts`, `server/src/modules/billing/plans.ts`, `server/src/modules/billing/routes.ts`, `server/src/modules/billing/controller.ts`, `server/src/modules/billing/validation.ts`
- Modify: `server/src/app.ts` (mount `/api/v1/billing`)
- Test: `server/src/modules/billing/__tests__/plans.test.ts`, `server/src/modules/billing/__int__/plans.int.test.ts`

**Interfaces:**
- Consumes: `getCatalog`, `SEATS_INCLUDED`, `SEATS_MAX`, `SEAT_SIZES`, `INTERVALS` (3.1); `resolveMode` (2.3); `NoHouseholdError` (2.1).
- Produces:
  - `interface CallerContext { userId: string; household: Household; membership: HouseholdMember; isAdmin: boolean; mode: BillingMode; memberCount: number }`
  - `loadCallerContext(userId: string): Promise<CallerContext>` (403 `NO_HOUSEHOLD`), `requireAdminContext(userId: string): Promise<CallerContext>` (403 `FORBIDDEN` for non-admins)
  - `interface PlansResponse { mode: BillingMode; priceSet: string; currency: string; seatsIncluded: number; seatsMax: number; matrix: Record<BillingInterval, Record<string, { priceId?: string; amount: number }>> }`
  - `getPlansForMode(mode: BillingMode): Promise<PlansResponse>`
  - `controller.ts`: `getUserId(req): string`, `plans` handler (later tasks add handlers to the same file)
  - `routes.ts` default export router (public routes first, then `router.use(authenticate)`)

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/plans.test.ts`:
```ts
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end' } }));

import { getPlansForMode } from '../plans';
import { clearLocalCatalogCache } from '../catalog';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices } from '../../../test/billing/fixtures';

describe('getPlansForMode', () => {
  it('returns the full matrix with price ids and amounts', async () => {
    clearLocalCatalogCache();
    const s = installStripeMock('test');
    const all = catalogPrices();
    s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
    const plans = await getPlansForMode('test');
    expect(plans).toMatchObject({ mode: 'test', priceSet: '2026-10', currency: 'usd', seatsIncluded: 5, seatsMax: 10 });
    expect(plans.matrix.month['5']).toEqual({ priceId: 'price_202610_5_month', amount: 899 });
    expect(plans.matrix.year['10']).toEqual({ priceId: 'price_202610_10_year', amount: 19939 });
    expect(Object.keys(plans.matrix.month)).toEqual(['5', '6', '7', '8', '9', '10']);
  });
});
```

`server/src/modules/billing/__int__/plans.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, createUser, authHeaderFor } from '../../../test/factories';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  const s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
});
afterAll(() => closeIntResources());

describe('GET /api/v1/billing/plans', () => {
  it('returns plans for a household member', async () => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app).get('/api/v1/billing/plans').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.matrix.year['7'].amount).toBe(12775);
  });

  it('returns 403 NO_HOUSEHOLD for a user without a household', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/v1/billing/plans').set(authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_HOUSEHOLD');
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/billing/plans')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/plans.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

`context.ts`:
```ts
import { Household, HouseholdMember } from '../../database/models';
import { ForbiddenError } from '../../shared/utils/errors';
import { NoHouseholdError } from './errors';
import { resolveMode } from './mode';
import type { BillingMode } from './types';

export interface CallerContext {
  userId: string;
  household: Household;
  membership: HouseholdMember;
  isAdmin: boolean;
  mode: BillingMode;
  memberCount: number;
}

export async function loadCallerContext(userId: string): Promise<CallerContext> {
  const membership = await HouseholdMember.findOne({ where: { userId } });
  if (!membership) throw new NoHouseholdError();
  const household = await Household.findByPk(membership.householdId, { paranoid: false });
  if (!household) throw new NoHouseholdError();
  const memberCount = await HouseholdMember.count({ where: { householdId: household.id } });
  return {
    userId, household, membership, isAdmin: membership.role === 'admin', mode: resolveMode(household), memberCount,
  };
}

export async function requireAdminContext(userId: string): Promise<CallerContext> {
  const ctx = await loadCallerContext(userId);
  if (!ctx.isAdmin) throw new ForbiddenError('Only a household admin can manage billing');
  return ctx;
}
```

`plans.ts`:
```ts
import { getCatalog, INTERVALS, SEAT_SIZES, SEATS_INCLUDED, SEATS_MAX } from './catalog';
import type { BillingInterval, BillingMode } from './types';

export interface PlansResponse {
  mode: BillingMode;
  priceSet: string;
  currency: string;
  seatsIncluded: number;
  seatsMax: number;
  matrix: Record<BillingInterval, Record<string, { priceId?: string; amount: number }>>;
}

export async function getPlansForMode(mode: BillingMode): Promise<PlansResponse> {
  const catalog = await getCatalog(mode);
  const matrix = { month: {}, year: {} } as PlansResponse['matrix'];
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      const p = catalog.prices.find((x) => x.interval === interval && x.seats === seats)!;
      matrix[interval][String(seats)] = { priceId: p.priceId, amount: p.amount };
    }
  }
  return { mode, priceSet: catalog.priceSet, currency: catalog.currency, seatsIncluded: SEATS_INCLUDED, seatsMax: SEATS_MAX, matrix };
}
```

`validation.ts` (grown in later tasks):
```ts
import { z } from 'zod';
import type { ValidationSchemas } from '../../shared/middleware/validate';

export const checkoutSchema: ValidationSchemas = {
  // Unknown keys (price, quantity, ...) are stripped: the server picks the price (B4).
  body: z.object({ interval: z.enum(['month', 'year']), seats: z.number().int().min(5).max(10) }),
};

export const planChangeSchema: ValidationSchemas = checkoutSchema;

export const syncParamsSchema: ValidationSchemas = {
  params: z.object({ sessionId: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/, 'Invalid session id') }),
};
```

`controller.ts`:
```ts
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import { loadCallerContext } from './context';
import { getPlansForMode } from './plans';

export function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function plans(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = await loadCallerContext(getUserId(req));
    res.status(200).json({ success: true, data: await getPlansForMode(ctx.mode) });
  } catch (e) { next(e); }
}
```

`routes.ts`:
```ts
import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import * as ctrl from './controller';

const router = Router();

// ── Public (no auth): the Checkout return page is added here in Task 5.6 ──

router.use(authenticate);

/**
 * @openapi
 * /billing/plans:
 *   get:
 *     tags: [Billing]
 *     summary: Price matrix for the caller's household mode (seats 5..10, month/year)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ mode, priceSet, currency, seatsIncluded, seatsMax, matrix }" }
 *       403: { description: NO_HOUSEHOLD }
 *       503: { description: BILLING_MODE_UNAVAILABLE or CATALOG_UNAVAILABLE }
 */
router.get('/plans', ctrl.plans);

export default router;
```

`app.ts`: `import billingRouter from './modules/billing/routes';` and under API Routes add `app.use('/api/v1/billing', billingRouter);`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/plans.test.ts && npm run test:int -- src/modules/billing/__int__/plans.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing server/src/app.ts
git commit -F - <<'MSG'
feat(billing): caller context, plans matrix and GET /billing/plans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 3 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && npm run billing:bootstrap -- --mode test --skip-webhooks
```
Acceptance:
- All green versus baseline.
- The bootstrap re-run reports `exists` for all 12 lookup keys (idempotent) against the dev sandbox; evidence file committed.
- With the server running (`npm run dev`), `GET /api/v1/billing/plans` with a real dev user token returns the 12 amounts of §6.1 (orchestrator spot-check; record the JSON in the evidence file).
- Sandbox Terms URL confirmed by the orchestrator.

---
## Wave 4: Entitlement and guards (§7.1–7.3)

### Task 4.1: Entitlement core, cache and batch check

**Files:**
- Create: `server/src/modules/billing/entitlement.ts`, `server/src/test/billing/rows.ts`, `server/src/test/unit/setup.ts`
- Modify: `server/jest.config.js` (`setupFiles`)
- Test: `server/src/modules/billing/__tests__/entitlement.test.ts`, `server/src/modules/billing/__int__/entitlement.int.test.ts`

**Interfaces:**
- Consumes: `resolveMode`, `livemodeOf` (2.3); cache helpers (2.4); models (2.5); `SEATS_INCLUDED`, `SEATS_MAX` (3.1).
- Produces:
  - `interface SubscriptionSnapshot { id: string; provider: BillingProvider; status: SubscriptionStatus; seats: number; interval: BillingInterval; graceUntil: Date | null; createdAt: Date; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean }`
  - `toSnapshot(row: BillingSubscription): SubscriptionSnapshot`
  - `computeEntitlement(input: { cohort: BillingCohort; mode: BillingMode; subscriptions: SubscriptionSnapshot[]; now: Date }): Entitlement` (pure)
  - `getEntitlement(householdId: string, opts?: { bypassCache?: boolean }): Promise<Entitlement>`
  - `clearEntitlementCache(householdId: string): Promise<void>` (both modes)
  - `isEntitledBatch(householdIds: string[], now?: Date): Promise<Set<string>>`
  - `ENTITLEMENT_TTL_SEC = 60`
  - test helpers `createSubscriptionRow(householdId: string, overrides?: Partial<BillingSubscription attrs>): Promise<BillingSubscription>`, `createCustomerRow(householdId: string, overrides?): Promise<BillingCustomer>`

Interpretation recorded in the self-review: when a household has both a healthy (`active`/`trialing`) and a `past_due` allowed-status row (possible only during §8.6 duplicate resolution), entitlement uses the healthy one even if it is older. This never grants more than one allowed subscription would.

- [ ] **Step 1: Add the unit-test Redis stub and row helpers**

`server/src/test/unit/setup.ts`:
```ts
// Unit tests never talk to Redis: a real ioredis client would retry forever and keep Jest alive.
// Individual tests can still jest.mock('.../config/redis') with their own stub.
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    status: 'end', get: jest.fn(), set: jest.fn(), del: jest.fn(), eval: jest.fn(), publish: jest.fn(),
    keys: jest.fn(async () => []), disconnect: jest.fn(), call: jest.fn(),
    duplicate: jest.fn(() => ({ on: jest.fn(), subscribe: jest.fn(async () => undefined) })),
  },
}));
```
`server/jest.config.js`: add `setupFiles: ['<rootDir>/src/test/unit/setup.ts'],`.

`server/src/test/billing/rows.ts`:
```ts
import { BillingSubscription, BillingCustomer } from '../../database/models';

let n = 0;

export async function createSubscriptionRow(householdId: string, overrides: Record<string, unknown> = {}): Promise<BillingSubscription> {
  n += 1;
  return BillingSubscription.create({
    householdId, provider: 'stripe', livemode: false, providerSubscriptionId: `sub_row${n}`,
    status: 'active', interval: 'month', seats: 5, priceId: 'price_202610_5_month', priceSet: '2026-10',
    unitAmount: 899, currency: 'usd', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
    ...overrides,
  });
}

export async function createCustomerRow(householdId: string, overrides: Record<string, unknown> = {}): Promise<BillingCustomer> {
  n += 1;
  return BillingCustomer.create({
    householdId, provider: 'stripe', livemode: false, providerCustomerId: `cus_row${n}`, billingEmail: 'admin@example.test',
    ...overrides,
  });
}
```

- [ ] **Step 2: Write the failing unit tests (every cohort × status × grace × mode combination)**

`server/src/modules/billing/__tests__/entitlement.test.ts`:
```ts
import { computeEntitlement, SubscriptionSnapshot } from '../entitlement';
import type { SubscriptionStatus } from '../types';

const NOW = new Date('2026-10-10T12:00:00Z');
const snap = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: 'row1', provider: 'stripe', status: 'active', seats: 7, interval: 'month', graceUntil: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: false, ...o,
});
const future = new Date(NOW.getTime() + 3600_000);
const past = new Date(NOW.getTime() - 3600_000);

describe('computeEntitlement (§7.1)', () => {
  const statuses: SubscriptionStatus[] = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'];

  for (const mode of ['test', 'live'] as const) {
    for (const status of statuses) {
      for (const grace of [null, future, past]) {
        const label = `${mode}/${status}/grace=${grace === null ? 'none' : grace === future ? 'future' : 'past'}`;

        it(`live cohort ${label}`, () => {
          const e = computeEntitlement({ cohort: 'live', mode, subscriptions: [snap({ status, graceUntil: grace })], now: NOW });
          const allowed = status === 'active' || status === 'trialing' || (status === 'past_due' && grace === future);
          expect(e.allowed).toBe(allowed);
          expect(e.mode).toBe(mode);
          if (status === 'active' || status === 'trialing') expect(e).toMatchObject({ reason: 'active', seatsAllowed: 7 });
          else if (allowed) expect(e).toMatchObject({ reason: 'grace', seatsAllowed: 7, graceUntil: future.toISOString() });
          else expect(e).toMatchObject({ reason: 'subscription_required', seatsAllowed: 5 });
        });

        it(`test cohort ${label} is always allowed with 10 seats`, () => {
          const e = computeEntitlement({ cohort: 'test', mode, subscriptions: [snap({ status, graceUntil: grace })], now: NOW });
          expect(e).toMatchObject({ allowed: true, reason: 'test_cohort', seatsAllowed: 10 });
        });
      }
    }
  }

  it('no subscription -> subscription_required with 5 seats', () => {
    expect(computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [], now: NOW }))
      .toEqual({ allowed: false, reason: 'subscription_required', mode: 'live', subscription: null, graceUntil: null, seatsAllowed: 5 });
  });

  it('grace boundary: now == graceUntil is blocked', () => {
    expect(computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [snap({ status: 'past_due', graceUntil: NOW })], now: NOW }).allowed).toBe(false);
  });

  it('prefers a healthy subscription over a past_due one', () => {
    const e = computeEntitlement({
      cohort: 'live', mode: 'live', now: NOW,
      subscriptions: [snap({ id: 'old', status: 'active', seats: 6, createdAt: new Date('2026-01-01') }), snap({ id: 'new', status: 'past_due', graceUntil: past, createdAt: new Date('2026-10-05') })],
    });
    expect(e).toMatchObject({ allowed: true, reason: 'active', seatsAllowed: 6, subscription: { id: 'old' } });
  });

  it('exposes the subscription view with ISO dates', () => {
    const e = computeEntitlement({ cohort: 'live', mode: 'live', subscriptions: [snap()], now: NOW });
    expect(e.subscription).toEqual({ id: 'row1', provider: 'stripe', status: 'active', seats: 7, interval: 'month', currentPeriodEnd: '2026-11-01T00:00:00.000Z', cancelAtPeriodEnd: false });
  });
});
```

- [ ] **Step 3: Write the failing integration test (mode filtering, cache, batch)**

`server/src/modules/billing/__int__/entitlement.int.test.ts`:
```ts
import { setupAssociations, Household } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { getEntitlement, isEntitledBatch, clearEntitlementCache } from '../entitlement';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('getEntitlement against MySQL', () => {
  it('counts only rows whose livemode matches the resolved mode (B3)', async () => {
    const { household } = await createHouseholdWithAdmin();
    // NODE_ENV=test resolves to 'test' mode: a live row must not unlock it.
    await createSubscriptionRow(household.id, { livemode: true, status: 'active' });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(false);
    await createSubscriptionRow(household.id, { livemode: false, status: 'active', seats: 8 });
    expect(await getEntitlement(household.id, { bypassCache: true })).toMatchObject({ allowed: true, seatsAllowed: 8, mode: 'test' });
  });

  it('honours the test cohort', async () => {
    const { household } = await createHouseholdWithAdmin({ cohort: 'test' });
    expect(await getEntitlement(household.id)).toMatchObject({ allowed: true, reason: 'test_cohort' });
  });

  it('finds soft-deleted households (paranoid: false)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    await Household.destroy({ where: { id: household.id } });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(true);
  });

  it('isEntitledBatch returns only allowed households', async () => {
    const a = (await createHouseholdWithAdmin()).household;
    const b = (await createHouseholdWithAdmin()).household;
    const c = (await createHouseholdWithAdmin({ cohort: 'test' })).household;
    await createSubscriptionRow(a.id);
    await createSubscriptionRow(b.id, { status: 'canceled' });
    const set = await isEntitledBatch([a.id, b.id, c.id, a.id]);
    expect([...set].sort()).toEqual([a.id, c.id].sort());
    await clearEntitlementCache(a.id);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/entitlement.test.ts`
Expected: FAIL, `../entitlement` not found.

- [ ] **Step 5: Implement `entitlement.ts` (core part)**

```ts
import { Op } from 'sequelize';
import { Household, BillingSubscription } from '../../database/models';
import { NotFoundError } from '../../shared/utils/errors';
import { cacheDel, cacheGetJson, cacheSetJson, entitlementKey } from './cache';
import { SEATS_INCLUDED, SEATS_MAX } from './catalog';
import { livemodeOf, resolveMode } from './mode';
import {
  ALLOWED_STATUSES, BillingCohort, BillingInterval, BillingMode, BillingProvider, Entitlement, EntitlementSubscription, SubscriptionStatus,
} from './types';

export const ENTITLEMENT_TTL_SEC = 60;

export interface SubscriptionSnapshot {
  id: string;
  provider: BillingProvider;
  status: SubscriptionStatus;
  seats: number;
  interval: BillingInterval;
  graceUntil: Date | null;
  createdAt: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export function toSnapshot(row: BillingSubscription): SubscriptionSnapshot {
  return {
    id: row.id, provider: row.provider, status: row.status, seats: row.seats, interval: row.interval,
    graceUntil: row.graceUntil, createdAt: row.createdAt, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

function view(s: SubscriptionSnapshot): EntitlementSubscription {
  return {
    id: s.id, provider: s.provider, status: s.status, seats: s.seats, interval: s.interval,
    currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  };
}

export function computeEntitlement(input: {
  cohort: BillingCohort; mode: BillingMode; subscriptions: SubscriptionSnapshot[]; now: Date;
}): Entitlement {
  const { cohort, mode, now } = input;
  const candidates = input.subscriptions
    .filter((s) => ALLOWED_STATUSES.includes(s.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const healthy = candidates.find((s) => s.status === 'active' || s.status === 'trialing');
  const pastDue = candidates.find((s) => s.status === 'past_due');

  if (cohort === 'test') {
    const best = healthy ?? pastDue;
    return { allowed: true, reason: 'test_cohort', mode, subscription: best ? view(best) : null, graceUntil: null, seatsAllowed: SEATS_MAX };
  }
  if (healthy) {
    return { allowed: true, reason: 'active', mode, subscription: view(healthy), graceUntil: null, seatsAllowed: healthy.seats };
  }
  if (pastDue && pastDue.graceUntil && now.getTime() < pastDue.graceUntil.getTime()) {
    return { allowed: true, reason: 'grace', mode, subscription: view(pastDue), graceUntil: pastDue.graceUntil.toISOString(), seatsAllowed: pastDue.seats };
  }
  return {
    allowed: false, reason: 'subscription_required', mode, subscription: pastDue ? view(pastDue) : null,
    graceUntil: pastDue?.graceUntil ? pastDue.graceUntil.toISOString() : null, seatsAllowed: SEATS_INCLUDED,
  };
}

export async function getEntitlement(householdId: string, opts: { bypassCache?: boolean } = {}): Promise<Entitlement> {
  const household = await Household.findByPk(householdId, { paranoid: false, attributes: ['id', 'billingCohort'] });
  if (!household) throw new NotFoundError('Household');
  const mode = resolveMode(household);
  const key = entitlementKey(mode, householdId);
  if (!opts.bypassCache) {
    const cached = await cacheGetJson<Entitlement>(key);
    if (cached) return cached;
  }
  const rows = await BillingSubscription.findAll({
    where: { householdId, livemode: livemodeOf(mode), status: { [Op.in]: [...ALLOWED_STATUSES] } },
  });
  const ent = computeEntitlement({ cohort: household.billingCohort, mode, subscriptions: rows.map(toSnapshot), now: new Date() });
  await cacheSetJson(key, ent, ENTITLEMENT_TTL_SEC);
  return ent;
}

export async function clearEntitlementCache(householdId: string): Promise<void> {
  await cacheDel(entitlementKey('test', householdId), entitlementKey('live', householdId));
}

/** For background jobs (§7.2): one query per table, no cache. */
export async function isEntitledBatch(householdIds: string[], now: Date = new Date()): Promise<Set<string>> {
  const ids = [...new Set(householdIds)];
  if (ids.length === 0) return new Set();
  const households = await Household.findAll({ where: { id: ids }, paranoid: false, attributes: ['id', 'billingCohort'] });
  const subs = await BillingSubscription.findAll({ where: { householdId: ids, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  const allowed = new Set<string>();
  for (const h of households) {
    const mode = resolveMode(h);
    const mine = subs.filter((s) => s.householdId === h.id && s.livemode === livemodeOf(mode)).map(toSnapshot);
    if (computeEntitlement({ cohort: h.billingCohort, mode, subscriptions: mine, now }).allowed) allowed.add(h.id);
  }
  return allowed;
}
```

- [ ] **Step 6: Run to verify they pass**

```bash
cd server && npx jest src/modules/billing/__tests__/entitlement.test.ts && npm run test:int -- src/modules/billing/__int__/entitlement.int.test.ts
cd server && npx jest   # whole unit suite still at baseline with the new setup file
```
Expected: PASS; unit suite at baseline.

- [ ] **Step 7: Commit**

```bash
git add server/jest.config.js server/src/test server/src/modules/billing/entitlement.ts server/src/modules/billing/__tests__/entitlement.test.ts server/src/modules/billing/__int__/entitlement.int.test.ts
git commit -F - <<'MSG'
feat(billing): entitlement computation, mode-keyed cache and batch check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 4.2: `requireEntitlement` on every guarded router (§7.2)

**Files:**
- Modify: `server/src/modules/billing/entitlement.ts` (middleware), `server/src/modules/{feed,task,grocery,todo,expense,vault,calendar,chat,checkin,ping,place,journal,dashboard,weather}/routes.ts`, `server/src/modules/notification/routes.ts`
- Test: `server/src/modules/billing/__tests__/requireEntitlement.test.ts`, `server/src/modules/billing/__int__/guards.int.test.ts`

**Interfaces:**
- Produces: `requireEntitlement: RequestHandler`; `interface BillingRequest extends AuthenticatedRequest { billing?: { householdId: string; entitlement: Entitlement; role: 'admin'|'member'|'child' } }`. Blocked responses: `402 { success:false, code:'SUBSCRIPTION_REQUIRED', reason, isAdmin, error, message }`; no household: `403 NO_HOUSEHOLD`.

- [ ] **Step 1: Write the failing unit test**

`server/src/modules/billing/__tests__/requireEntitlement.test.ts`:
```ts
jest.mock('../../../database/models', () => ({
  HouseholdMember: { findOne: jest.fn() },
  Household: { findByPk: jest.fn(), findAll: jest.fn() },
  BillingSubscription: { findAll: jest.fn() },
}));
import * as models from '../../../database/models';
import { requireEntitlement } from '../entitlement';

const run = (req: any) => new Promise<unknown>((resolve) => requireEntitlement(req, {} as any, resolve));

beforeEach(() => jest.clearAllMocks());

describe('requireEntitlement', () => {
  const req = () => ({ user: { userId: 'u1' } });

  it('403 NO_HOUSEHOLD without a membership', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
    expect(await run(req())).toMatchObject({ statusCode: 403, code: 'NO_HOUSEHOLD' });
  });

  it('402 SUBSCRIPTION_REQUIRED with reason and isAdmin', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'h1', role: 'admin' });
    (models.Household.findByPk as jest.Mock).mockResolvedValue({ id: 'h1', billingCohort: 'live' });
    (models.BillingSubscription.findAll as jest.Mock).mockResolvedValue([]);
    expect(await run(req())).toMatchObject({ statusCode: 402, code: 'SUBSCRIPTION_REQUIRED', details: { reason: 'subscription_required', isAdmin: true } });
  });

  it('calls next() and attaches billing context when allowed', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'h1', role: 'member' });
    (models.Household.findByPk as jest.Mock).mockResolvedValue({ id: 'h1', billingCohort: 'test' });
    (models.BillingSubscription.findAll as jest.Mock).mockResolvedValue([]);
    const r: any = req();
    expect(await run(r)).toBeUndefined();
    expect(r.billing).toMatchObject({ householdId: 'h1', role: 'member', entitlement: { reason: 'test_cohort' } });
  });
});
```
Run: `cd server && npx jest src/modules/billing/__tests__/requireEntitlement.test.ts` → FAIL (`requireEntitlement` not exported).

- [ ] **Step 2: Implement the middleware** (append to `entitlement.ts`)

```ts
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { HouseholdMember } from '../../database/models';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import { NoHouseholdError, PaymentRequiredError } from './errors';

export interface BillingRequest extends AuthenticatedRequest {
  billing?: { householdId: string; entitlement: Entitlement; role: 'admin' | 'member' | 'child' };
}

async function requireEntitlementAsync(req: Request, next: NextFunction): Promise<void> {
  const userId = (req as AuthenticatedRequest).user!.userId;
  const membership = await HouseholdMember.findOne({ where: { userId }, attributes: ['householdId', 'role'] });
  if (!membership) throw new NoHouseholdError();
  const entitlement = await getEntitlement(membership.householdId);
  if (!entitlement.allowed) {
    throw new PaymentRequiredError('SUBSCRIPTION_REQUIRED', 'A Rootaroo subscription is required', {
      reason: entitlement.reason, isAdmin: membership.role === 'admin',
    });
  }
  (req as BillingRequest).billing = { householdId: membership.householdId, entitlement, role: membership.role };
  next();
}

/** Mounted inside each guarded router, after `authenticate` (§7.2). */
export const requireEntitlement: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  requireEntitlementAsync(req, next).catch(next);
};
```
(Merge these imports with the file's existing import block; `HouseholdMember` joins the existing models import.)

- [ ] **Step 3: Mount it**

In each of `feed, task, grocery, todo, expense, vault, calendar, chat, checkin, ping, place, journal, dashboard, weather` `routes.ts`, directly below `router.use(authenticate);` add:
```ts
router.use(requireEntitlement);
```
with `import { requireEntitlement } from '../billing/entitlement';`. (`calendar/feedRoutes.ts`, the public ICS feed, is not touched here; see Task 4.5.)

In `notification/routes.ts`, guard only the history routes:
```ts
router.get('/history', requireEntitlement, ctrl.getHistory);
router.post('/history/:id/read', requireEntitlement, ctrl.markAsRead);
router.post('/history/read-all', requireEntitlement, ctrl.markAllAsRead);
```
`tokens`, `preferences` and `unread-count` stay unguarded.

- [ ] **Step 4: Write the integration test (every guarded route 402, unguarded routes work, no household 403)**

`server/src/modules/billing/__int__/guards.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, createUser, authHeaderFor } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const GUARDED: Array<['get' | 'post', string]> = [
  ['get', '/api/v1/feed'], ['get', '/api/v1/tasks'], ['get', '/api/v1/groceries'], ['get', '/api/v1/todos'],
  ['get', '/api/v1/expenses'], ['get', '/api/v1/vault'], ['get', '/api/v1/events'], ['get', '/api/v1/chat/conversations'],
  ['get', '/api/v1/checkins'], ['get', '/api/v1/pings'], ['get', '/api/v1/places'], ['get', '/api/v1/journal'],
  ['get', '/api/v1/dashboard'], ['get', '/api/v1/weather'], ['get', '/api/v1/events/export.ics'],
  ['get', '/api/v1/notifications/history'], ['post', '/api/v1/notifications/history/read-all'],
  ['post', '/api/v1/notifications/history/00000000-0000-4000-8000-000000000000/read'],
];

describe('paywall guards (B7)', () => {
  it.each(GUARDED)('%s %s -> 402 for a blocked household', async (method, path) => {
    const { household } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    const res = await request(app)[method](path).set(authHeaderFor(member));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: 'SUBSCRIPTION_REQUIRED', reason: 'subscription_required', isAdmin: false });
  });

  it('reports isAdmin=true for the admin', async () => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app).get('/api/v1/tasks').set(authHeaderFor(admin));
    expect(res.body.isAdmin).toBe(true);
  });

  it.each([
    ['get', '/api/v1/households'], ['get', '/api/v1/notifications/unread-count'],
    ['get', '/api/v1/notifications/preferences'], ['get', '/api/v1/auth/me'],
  ] as Array<['get', string]>)('%s %s stays reachable while blocked', async (method, path) => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app)[method](path).set(authHeaderFor(admin));
    expect(res.status).toBe(200);
  });

  it('guarded routes return 403 NO_HOUSEHOLD without a household', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/v1/tasks').set(authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_HOUSEHOLD');
  });

  it('an active subscription or the test cohort unlocks guarded routes', async () => {
    const paid = await createHouseholdWithAdmin();
    await createSubscriptionRow(paid.household.id);
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(paid.admin))).status).not.toBe(402);
    const testCohort = await createHouseholdWithAdmin({ cohort: 'test' });
    expect((await request(app).get('/api/v1/groceries').set(authHeaderFor(testCohort.admin))).status).not.toBe(402);
  });

  it('grace keeps access; expired grace blocks', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const sub = await createSubscriptionRow(household.id, { status: 'past_due', graceUntil: new Date(Date.now() + 86400_000) });
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(admin))).status).not.toBe(402);
    await sub.update({ graceUntil: new Date(Date.now() - 1000) });
    await (await import('../entitlement')).clearEntitlementCache(household.id);
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(admin))).status).toBe(402);
  });
});
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd server && npx jest src/modules/billing/__tests__/requireEntitlement.test.ts
cd server && npm run test:int -- src/modules/billing/__int__/guards.int.test.ts
cd server && npx jest && npm run type-check
```
Expected: PASS; existing unit suites unchanged (they test services, not routers).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules
git commit -F - <<'MSG'
feat(billing): enforce the paywall on every guarded router

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 4.3: Seat checks in join (§7.3)

**Files:**
- Create: `server/src/shared/utils/dbRetry.ts`
- Modify: `server/src/modules/billing/entitlement.ts`, `server/src/modules/household/service.ts` (`joinViaCode`, `removeMember`, `leaveHousehold`)
- Test: `server/src/shared/utils/__tests__/dbRetry.test.ts`, `server/src/modules/household/__tests__/household.service.test.ts`, `server/src/modules/billing/__int__/seats.int.test.ts`

**Interfaces:**
- Produces:
  - `isDeadlock(err: unknown): boolean`, `withDeadlockRetry<T>(fn: () => Promise<T>, retries?: number): Promise<T>` (default 3 retries = 4 attempts)
  - `seatsAllowedInTransaction(householdId: string, transaction: Transaction): Promise<number>` (locks the household row `FOR UPDATE`, reads `billing_subscriptions` directly, never the cache)
  - `assertSeatAvailable(householdId: string, transaction: Transaction): Promise<void>` (throws `402 SEAT_LIMIT { seatsAllowed, memberCount }`)

`joinViaCode` is the only member-add path in the codebase (`createHousehold` adds the first member to an empty household); the check is placed there.

- [ ] **Step 1: Write the failing tests**

`server/src/shared/utils/__tests__/dbRetry.test.ts`:
```ts
import { withDeadlockRetry, isDeadlock } from '../dbRetry';

const deadlock = () => Object.assign(new Error('Deadlock'), { parent: { code: 'ER_LOCK_DEADLOCK' } });

describe('withDeadlockRetry', () => {
  it('detects deadlocks on parent/original/code', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(isDeadlock({ original: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true);
    expect(isDeadlock(new Error('x'))).toBe(false);
  });

  it('retries up to 3 times then succeeds', async () => {
    const fn = jest.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockResolvedValue('ok');
    await expect(withDeadlockRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('gives up after 3 retries', async () => {
    const fn = jest.fn().mockRejectedValue(deadlock());
    await expect(withDeadlockRetry(fn)).rejects.toThrow('Deadlock');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not retry other errors', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('other'));
    await expect(withDeadlockRetry(fn)).rejects.toThrow('other');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

In `household.service.test.ts`, add near the other `jest.mock` calls:
```ts
jest.mock('../../billing/entitlement', () => ({
  assertSeatAvailable: jest.fn().mockResolvedValue(undefined),
  clearEntitlementCache: jest.fn().mockResolvedValue(undefined),
}));
import { assertSeatAvailable, clearEntitlementCache } from '../../billing/entitlement';
import { PaymentRequiredError } from '../../billing/errors';
```
and inside `describe('joinViaCode', ...)`, reusing the file's existing happy-path arrangement (copy the `mockResolvedValue` lines from its first success test into a local `arrangeValidInvite()` helper at the top of that describe):
```ts
    it('checks seats inside the join transaction and clears the entitlement cache', async () => {
      arrangeValidInvite();
      await joinViaCode(otherUserId, { code: 'INVITE99' });
      expect(assertSeatAvailable).toHaveBeenCalledWith(householdId, expect.anything());
      expect(clearEntitlementCache).toHaveBeenCalledWith(householdId);
    });

    it('propagates 402 SEAT_LIMIT and creates no membership', async () => {
      arrangeValidInvite();
      (assertSeatAvailable as jest.Mock).mockRejectedValueOnce(new PaymentRequiredError('SEAT_LIMIT', 'full'));
      await expect(joinViaCode(otherUserId, { code: 'INVITE99' })).rejects.toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT' });
      expect(models.HouseholdMember.create).not.toHaveBeenCalled();
    });
```

`server/src/modules/billing/__int__/seats.int.test.ts`:
```ts
import { setupAssociations, HouseholdMember } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, createUser } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { joinViaCode } from '../../household/service';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('seat limits (§7.3)', () => {
  it('concurrent joins at the limit: exactly one succeeds', async () => {
    const { household } = await createHouseholdWithAdmin();
    for (let i = 0; i < 3; i++) await addMember(household.id); // 4 members, 5 allowed
    const [u1, u2] = [await createUser(), await createUser()];
    const results = await Promise.allSettled([
      joinViaCode(u1.id, { code: household.inviteCode }),
      joinViaCode(u2.id, { code: household.inviteCode }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT' });
    expect(await HouseholdMember.count({ where: { householdId: household.id } })).toBe(5);
  });

  it('uses subscription seats, and the test cohort gets 10', async () => {
    const paid = await createHouseholdWithAdmin();
    await createSubscriptionRow(paid.household.id, { seats: 6 });
    for (let i = 0; i < 4; i++) await addMember(paid.household.id);
    await expect(joinViaCode((await createUser()).id, { code: paid.household.inviteCode })).resolves.toBeTruthy();
    await expect(joinViaCode((await createUser()).id, { code: paid.household.inviteCode })).rejects.toMatchObject({ code: 'SEAT_LIMIT' });

    const t = await createHouseholdWithAdmin({ cohort: 'test' });
    for (let i = 0; i < 8; i++) await addMember(t.household.id);
    await expect(joinViaCode((await createUser()).id, { code: t.household.inviteCode })).resolves.toBeTruthy();
    await expect(joinViaCode((await createUser()).id, { code: t.household.inviteCode })).rejects.toMatchObject({ code: 'SEAT_LIMIT' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/shared/utils/__tests__/dbRetry.test.ts src/modules/household`
Expected: FAIL (`dbRetry` missing; seat assertions not called).

- [ ] **Step 3: Implement**

`server/src/shared/utils/dbRetry.ts`:
```ts
export function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; parent?: { code?: string }; original?: { code?: string } } | null;
  return [e?.code, e?.parent?.code, e?.original?.code].includes('ER_LOCK_DEADLOCK');
}

/** Re-runs a whole transaction when MySQL picks it as a deadlock victim. */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
}
```

Append to `entitlement.ts` (add `Transaction` to the `sequelize` import):
```ts
export async function seatsAllowedInTransaction(householdId: string, transaction: Transaction): Promise<number> {
  const household = await Household.findByPk(householdId, { transaction, lock: Transaction.LOCK.UPDATE, paranoid: false });
  if (!household) throw new NotFoundError('Household');
  const mode = resolveMode(household);
  const rows = await BillingSubscription.findAll({
    where: { householdId, livemode: livemodeOf(mode), status: { [Op.in]: [...ALLOWED_STATUSES] } },
    transaction,
  });
  const ent = computeEntitlement({ cohort: household.billingCohort, mode, subscriptions: rows.map(toSnapshot), now: new Date() });
  return Math.min(ent.seatsAllowed, SEATS_MAX);
}

export async function assertSeatAvailable(householdId: string, transaction: Transaction): Promise<void> {
  const seatsAllowed = await seatsAllowedInTransaction(householdId, transaction);
  const memberCount = await HouseholdMember.count({ where: { householdId }, transaction });
  if (memberCount >= seatsAllowed) {
    throw new PaymentRequiredError('SEAT_LIMIT', `This household's plan allows ${seatsAllowed} members`, { seatsAllowed, memberCount });
  }
}
```

`household/service.ts`:
- imports: `import { withDeadlockRetry } from '../../shared/utils/dbRetry';` and `import { assertSeatAvailable, clearEntitlementCache } from '../billing/entitlement';`
- wrap the join transaction: `const { household } = await withDeadlockRetry(() => sequelize.transaction(` … `));` (close the extra parenthesis after the existing transaction callback).
- immediately before `// Join` / `HouseholdMember.create(...)`, add:
```ts
      // §7.3: seats come from billing_subscriptions inside this transaction,
      // with the household row locked FOR UPDATE (hard cap 10 for everyone).
      await assertSeatAvailable(household.id, transaction);
```
- after the transaction resolves (before `addToHouseholdConversation`): `await clearEntitlementCache(household.id);`
- at the end of `removeMember` and `leaveHousehold`: `await clearEntitlementCache(householdId);`

- [ ] **Step 4: Run to verify they pass**

```bash
cd server && npx jest src/shared/utils/__tests__/dbRetry.test.ts src/modules/household
cd server && npm run test:int -- src/modules/billing/__int__/seats.int.test.ts
```
Expected: PASS, including the concurrent-join test (a deadlock between the two SERIALIZABLE transactions is retried, then the loser sees 5 members and gets `SEAT_LIMIT`).

- [ ] **Step 5: Commit**

```bash
git add server/src/shared/utils/dbRetry.ts server/src/shared/utils/__tests__/dbRetry.test.ts server/src/modules/billing server/src/modules/household
git commit -F - <<'MSG'
feat(billing): seat limits on join with row lock and deadlock retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 4.4: Socket gating (§7.2 Sockets)

**Files:**
- Create: `server/src/modules/billing/socketGate.ts`
- Modify: `server/src/shared/middleware/socketAuth.ts` (`SocketUserData` + prime on connect), `server/src/socket/chatSocket.ts`, and the six household-room emitters: `server/src/modules/calendar/service.ts:154`, `checkin/service.ts:103`, `feed/service.ts:275`, `grocery/service.ts:203`, `task/service.ts:389`, `todo/service.ts:211`; their unit tests in `server/src/modules/{calendar,checkin,feed,grocery,task,todo}/__tests__/*.service.test.ts`
- Test: `server/src/modules/billing/__tests__/socketGate.test.ts`, `server/src/modules/billing/__int__/sockets.int.test.ts`

**Interfaces:**
- Consumes: `getEntitlement` (4.1), `getIO` (`shared/utils/socket`).
- Produces: `SOCKET_ENTITLEMENT_TTL_MS = 60_000`; `isSocketEntitled(socket: AuthenticatedSocket, now?: number): Promise<boolean>`; `emitToHousehold(householdId: string, event: string, payload: unknown): Promise<void>`; `SocketUserData` gains `billingAllowed?: boolean; billingCheckedAt?: number; billingHouseholdId?: string`.

Chat message broadcasts go to conversation rooms from guarded REST routes (`chat/service.ts` lines 443–714), so they are already blocked by the 402; only `household:` room emits change here.

- [ ] **Step 1: Write the failing unit test**

`server/src/modules/billing/__tests__/socketGate.test.ts`:
```ts
jest.mock('../entitlement', () => ({ getEntitlement: jest.fn() }));
const emit = jest.fn();
jest.mock('../../../shared/utils/socket', () => ({ getIO: () => ({ to: jest.fn(() => ({ emit })) }) }));

import { getEntitlement } from '../entitlement';
import { isSocketEntitled, emitToHousehold } from '../socketGate';

const sock = (data: any = {}) => ({ data: { userId: 'u', householdId: 'h1', ...data } }) as any;

beforeEach(() => jest.clearAllMocks());

describe('isSocketEntitled', () => {
  it('caches the answer for 60 seconds per household', async () => {
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: true });
    const s = sock();
    expect(await isSocketEntitled(s, 1_000)).toBe(true);
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: false });
    expect(await isSocketEntitled(s, 50_000)).toBe(true);
    expect(await isSocketEntitled(s, 62_000)).toBe(false);
    expect(getEntitlement).toHaveBeenCalledTimes(2);
  });

  it('re-checks when the socket switches household', async () => {
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: true });
    const s = sock();
    await isSocketEntitled(s, 1_000);
    s.data.householdId = 'h2';
    await isSocketEntitled(s, 2_000);
    expect(getEntitlement).toHaveBeenLastCalledWith('h2');
  });

  it('is false without a household and keeps the last answer on lookup errors', async () => {
    expect(await isSocketEntitled(sock({ householdId: null }))).toBe(false);
    const s = sock({ billingAllowed: true, billingCheckedAt: 0, billingHouseholdId: 'h1' });
    (getEntitlement as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(await isSocketEntitled(s, 120_000)).toBe(true);
  });
});

describe('emitToHousehold', () => {
  it('skips blocked households and emits for allowed ones', async () => {
    (getEntitlement as jest.Mock).mockResolvedValueOnce({ allowed: false });
    await emitToHousehold('h1', 'task:completed', { id: 1 });
    expect(emit).not.toHaveBeenCalled();
    (getEntitlement as jest.Mock).mockResolvedValueOnce({ allowed: true });
    await emitToHousehold('h1', 'task:completed', { id: 1 });
    expect(emit).toHaveBeenCalledWith('task:completed', { id: 1 });
  });

  it('never throws', async () => {
    (getEntitlement as jest.Mock).mockRejectedValue(new Error('x'));
    await expect(emitToHousehold('h1', 'e', {})).resolves.toBeUndefined();
  });
});
```
Run → FAIL (module missing).

- [ ] **Step 2: Implement `socketGate.ts`**

```ts
import type { AuthenticatedSocket } from '../../shared/middleware/socketAuth';
import { getIO } from '../../shared/utils/socket';
import logger from '../../shared/utils/logger';
import { getEntitlement } from './entitlement';

export const SOCKET_ENTITLEMENT_TTL_MS = 60_000;

export async function isSocketEntitled(socket: AuthenticatedSocket, now: number = Date.now()): Promise<boolean> {
  const householdId = socket.data.householdId;
  if (!householdId) return false;
  const fresh = socket.data.billingCheckedAt !== undefined
    && socket.data.billingHouseholdId === householdId
    && now - socket.data.billingCheckedAt < SOCKET_ENTITLEMENT_TTL_MS;
  if (fresh) return socket.data.billingAllowed === true;
  try {
    socket.data.billingAllowed = (await getEntitlement(householdId)).allowed;
  } catch (err) {
    logger.warn(`[Billing] socket entitlement check failed for ${householdId}: ${(err as Error).message}`);
    socket.data.billingAllowed = socket.data.billingAllowed ?? false;
  }
  socket.data.billingCheckedAt = now;
  socket.data.billingHouseholdId = householdId;
  return socket.data.billingAllowed;
}

/** Server-side household-room emit that is skipped for blocked households (§7.2). */
export async function emitToHousehold(householdId: string, event: string, payload: unknown): Promise<void> {
  try {
    if (!(await getEntitlement(householdId)).allowed) return;
    getIO().to(`household:${householdId}`).emit(event, payload);
  } catch (err) {
    logger.warn(`[Billing] emitToHousehold(${event}) skipped: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 3: Wire sockets**

`socketAuth.ts`: extend the interface:
```ts
export interface SocketUserData {
  userId: string;
  email: string;
  role: string;
  householdId: string | null;
  billingAllowed?: boolean;
  billingCheckedAt?: number;
  billingHouseholdId?: string;
}
```
and in the `connection` handler, after joining rooms: `void isSocketEntitled(socket);` (import from `../../modules/billing/socketGate`).

`chatSocket.ts`: make every handler `async` and add, after the `requireHouseholdAccess` line in each of `chat:typing`, `chat:stop-typing`, `chat:read`, `presence:online`:
```ts
      if (!(await isSocketEntitled(socket))) return;
```
(import `isSocketEntitled` from `../modules/billing/socketGate`).

In each of the six services replace the household emit, e.g. in `task/service.ts`:
```ts
    void emitToHousehold(householdId, 'task:completed', response);
```
(`calendar`: `'calendar:event-created'`; `checkin`: `'checkin:created'`; `feed`: `'feed:new-post'` with `result`; `grocery`: `'grocery:bought'`; `todo`: `'todo:completed'`), importing `emitToHousehold` from `'../billing/socketGate'`. Remove a now-unused `getIO` import if `noUnusedLocals` complains. In each of those six services' test files add:
```ts
jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
```
and change any assertion on `getIO().to(...).emit(...)` for these events to `expect(emitToHousehold).toHaveBeenCalledWith(householdId, '<event>', expect.anything())` (import it from `'../../billing/socketGate'`). Find them with `grep -n "emit" src/modules/{calendar,checkin,feed,grocery,task,todo}/__tests__/*.ts`.

- [ ] **Step 4: Write the socket integration test**

`server/src/modules/billing/__int__/sockets.int.test.ts`:
```ts
import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, Socket } from 'socket.io-client';
import { env } from '../../../config/env';
import { setupAssociations } from '../../../database/models';
import { socketAuthMiddleware, setupSocketConnectionHandlers } from '../../../shared/middleware/socketAuth';
import { registerChatSocket } from '../../../socket/chatSocket';
import { setIO } from '../../../shared/utils/socket';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';

let server: http.Server; let ioServer: Server; let url: string;
const clients: Socket[] = [];

beforeAll(async () => {
  setupAssociations();
  server = http.createServer();
  ioServer = new Server(server);
  socketAuthMiddleware(ioServer); setupSocketConnectionHandlers(ioServer); registerChatSocket(ioServer); setIO(ioServer);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => resetDb());
afterEach(() => { clients.splice(0).forEach((c) => c.close()); });
afterAll(async () => { ioServer.close(); await closeIntResources(); });

function client(user: { id: string; email: string; role: string }): Promise<Socket> {
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, env.jwt.accessSecret);
  const c = connect(url, { auth: { token }, transports: ['websocket'] });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => resolve(c)));
}

const received = (c: Socket, event: string, ms = 500) =>
  new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), ms); c.once(event, () => { clearTimeout(t); resolve(true); }); });

describe('socket gating (B7)', () => {
  it('drops chat:typing from a blocked household', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    const [a, b] = [await client(admin), await client(member)];
    const got = received(b, 'chat:typing');
    a.emit('chat:typing', { householdId: household.id });
    expect(await got).toBe(false);
  });

  it('relays chat:typing for an entitled household', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    const member = await addMember(household.id);
    const [a, b] = [await client(admin), await client(member)];
    const got = received(b, 'chat:typing', 1500);
    a.emit('chat:typing', { householdId: household.id });
    expect(await got).toBe(true);
  });
});
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd server && npx jest src/modules/billing/__tests__/socketGate.test.ts src/modules/calendar src/modules/checkin src/modules/feed src/modules/grocery src/modules/task src/modules/todo
cd server && npm run test:int -- src/modules/billing/__int__/sockets.int.test.ts
cd server && npm run type-check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src
git commit -F - <<'MSG'
feat(billing): gate socket handlers and household-room emits on entitlement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 4.5: Empty ICS feed, job filtering, `/uploads` in production (§7.2)

**Files:**
- Create: `server/src/shared/middleware/uploads.ts`
- Modify: `server/src/modules/calendar/service.ts` (`emptyCalendarIcs`, `getOutlookFeedIcs`, `notifyUpcomingEvents`), `server/src/jobs/grocery-archive.ts`, `server/src/jobs/overdue-points.ts`, `server/src/jobs/calendar-sync.ts`, `server/src/app.ts`, `server/src/index.ts`
- Test: `server/src/jobs/__tests__/billingFilters.test.ts`, `server/src/shared/middleware/__tests__/uploads.test.ts`, `server/src/modules/calendar/__tests__/calendar.service.test.ts`

**Interfaces:**
- Consumes: `isEntitledBatch` (4.1).
- Produces: `emptyCalendarIcs(): string`; `runGroceryArchive(now?: Date): Promise<number>`; `runOverduePointsReduction(now?: Date): Promise<number>`; `runCalendarSync(): Promise<number>`; `shouldServeUploads(nodeEnv: string): boolean`; `assertNoUploadsInProduction(app: Express, nodeEnv: string): void`.

- [ ] **Step 1: Write the failing tests**

`server/src/jobs/__tests__/billingFilters.test.ts`:
```ts
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../modules/billing/entitlement', () => ({ isEntitledBatch: jest.fn() }));
jest.mock('../../modules/calendar/service', () => ({ syncUserCalendar: jest.fn(), syncAppleUserCalendar: jest.fn(), notifyUpcomingEvents: jest.fn() }));
jest.mock('../../database/models', () => ({
  sequelize: { fn: jest.fn((...a: unknown[]) => a), col: jest.fn((c: string) => c) },
  GroceryItem: { findAll: jest.fn(), update: jest.fn() },
  Task: { findAll: jest.fn() },
  CalendarSyncState: { findAll: jest.fn() },
  HouseholdMember: { findAll: jest.fn() },
}));

import * as models from '../../database/models';
import { isEntitledBatch } from '../../modules/billing/entitlement';
import { syncUserCalendar } from '../../modules/calendar/service';
import { runGroceryArchive } from '../grocery-archive';
import { runOverduePointsReduction } from '../overdue-points';
import { runCalendarSync } from '../calendar-sync';

beforeEach(() => jest.clearAllMocks());

describe('job filtering by entitlement', () => {
  it('grocery-archive only archives entitled households', async () => {
    (models.GroceryItem.findAll as jest.Mock).mockResolvedValue([{ householdId: 'ok' }, { householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    (models.GroceryItem.update as jest.Mock).mockResolvedValue([3]);
    expect(await runGroceryArchive(new Date('2026-10-10'))).toBe(3);
    expect((models.GroceryItem.update as jest.Mock).mock.calls[0][1].where.householdId).toEqual(['ok']);
  });

  it('grocery-archive does nothing when no household is entitled', async () => {
    (models.GroceryItem.findAll as jest.Mock).mockResolvedValue([{ householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set());
    expect(await runGroceryArchive()).toBe(0);
    expect(models.GroceryItem.update).not.toHaveBeenCalled();
  });

  it('overdue-points skips blocked households', async () => {
    const ok = { householdId: 'ok', points: 10, update: jest.fn() };
    const blocked = { householdId: 'blocked', points: 10, update: jest.fn() };
    (models.Task.findAll as jest.Mock).mockResolvedValue([ok, blocked]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    expect(await runOverduePointsReduction()).toBe(1);
    expect(ok.update).toHaveBeenCalledWith({ points: 5, pointsReduced: true });
    expect(blocked.update).not.toHaveBeenCalled();
  });

  it('calendar-sync skips users whose household is blocked', async () => {
    (models.CalendarSyncState.findAll as jest.Mock).mockResolvedValue([{ userId: 'u1', provider: 'google' }, { userId: 'u2', provider: 'google' }]);
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'u1', householdId: 'ok' }, { userId: 'u2', householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    expect(await runCalendarSync()).toBe(1);
    expect(syncUserCalendar).toHaveBeenCalledWith('u1');
    expect(syncUserCalendar).not.toHaveBeenCalledWith('u2');
  });
});
```

`server/src/shared/middleware/__tests__/uploads.test.ts`:
```ts
import express from 'express';
import path from 'path';
import { shouldServeUploads, assertNoUploadsInProduction } from '../uploads';

describe('uploads static serving', () => {
  it('is only served outside production', () => {
    expect(shouldServeUploads('development')).toBe(true);
    expect(shouldServeUploads('production')).toBe(false);
  });

  it('startup assertion exits when /uploads is mounted in production', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.use('/uploads', express.static(path.resolve('./uploads')));
    app.use((_req, res) => { res.status(404).end(); });
    assertNoUploadsInProduction(app, 'production');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    const clean = express();
    clean.use((_req, res) => { res.status(404).end(); });
    assertNoUploadsInProduction(clean, 'production');
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
```

Add to `calendar.service.test.ts` (with `jest.mock('../../billing/entitlement', () => ({ isEntitledBatch: jest.fn() }))` at the top, imported as `isEntitledBatch`, and `CalendarSyncState.findOne` available in that file's model mock):
```ts
  describe('Outlook ICS feed paywall (B10)', () => {
    it('returns a valid empty calendar for a blocked household', async () => {
      (models.CalendarSyncState.findOne as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'hh-1' });
      (isEntitledBatch as jest.Mock).mockResolvedValue(new Set());
      const ics = await getOutlookFeedIcs('tok');
      expect(ics).toBe(emptyCalendarIcs());
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/jobs/__tests__/billingFilters.test.ts src/shared/middleware/__tests__/uploads.test.ts src/modules/calendar`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`server/src/jobs/grocery-archive.ts`:
```ts
import cron from 'node-cron';
import { Op } from 'sequelize';
import { sequelize, GroceryItem } from '../database/models';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

/** Archive items bought more than 24 h ago, for entitled households only (§7.2). */
export async function runGroceryArchive(now: Date = new Date()): Promise<number> {
  const where = { isBought: true, boughtAt: { [Op.lte]: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, archivedAt: null };
  const rows = (await GroceryItem.findAll({
    where, attributes: [[sequelize.fn('DISTINCT', sequelize.col('household_id')), 'householdId']], raw: true,
  })) as unknown as Array<{ householdId: string }>;
  const allowed = await isEntitledBatch(rows.map((r) => r.householdId));
  if (allowed.size === 0) return 0;
  const [count] = await GroceryItem.update({ archivedAt: now }, { where: { ...where, householdId: [...allowed] } });
  return count;
}

export function startGroceryArchiveJob(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const count = await runGroceryArchive();
      if (count > 0) logger.info(`[Auto-Archive] Archived ${count} grocery items older than 24h`);
    } catch (err) {
      logger.error('[Auto-Archive] Failed:', err);
    }
  });
  logger.info('[Auto-Archive] Cron job registered — runs every hour');
}
```

`server/src/jobs/overdue-points.ts`:
```ts
import cron from 'node-cron';
import { Op } from 'sequelize';
import { Task } from '../database/models';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

/** One-time halving of overdue task points, entitled households only (§7.2). */
export async function runOverduePointsReduction(now: Date = new Date()): Promise<number> {
  const candidates = await Task.findAll({
    where: { status: { [Op.in]: ['pending', 'reopened'] }, pointsReduced: false, dueDate: { [Op.not]: null, [Op.lt]: now } },
  });
  const allowed = await isEntitledBatch(candidates.map((t) => t.householdId));
  let count = 0;
  for (const task of candidates) {
    if (!allowed.has(task.householdId)) continue;
    await task.update({ points: Math.max(0, Math.floor(task.points / 2)), pointsReduced: true });
    count++;
  }
  return count;
}

export function startOverduePointsReductionJob(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const count = await runOverduePointsReduction();
      if (count > 0) logger.info(`[Overdue Points] Reduced points for ${count} overdue task(s)`);
    } catch (err) {
      logger.error('[Overdue Points] Failed:', err);
    }
  });
  logger.info('[Overdue Points] Cron job registered — runs every hour');
}
```

`server/src/jobs/calendar-sync.ts`:
```ts
import cron from 'node-cron';
import { CalendarSyncState, HouseholdMember } from '../database/models';
import { syncUserCalendar, syncAppleUserCalendar } from '../modules/calendar/service';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

export async function runCalendarSync(): Promise<number> {
  const states = await CalendarSyncState.findAll({ where: { isActive: true, provider: ['google', 'apple'] }, attributes: ['userId', 'provider'] });
  if (states.length === 0) return 0;
  const memberships = await HouseholdMember.findAll({ where: { userId: [...new Set(states.map((s) => s.userId))] }, attributes: ['userId', 'householdId'] });
  const householdOf = new Map(memberships.map((m) => [m.userId, m.householdId]));
  const allowed = await isEntitledBatch([...householdOf.values()]);
  let synced = 0;
  for (const state of states) {
    const householdId = householdOf.get(state.userId);
    if (!householdId || !allowed.has(householdId)) continue;
    try {
      if (state.provider === 'google') await syncUserCalendar(state.userId);
      else if (state.provider === 'apple') await syncAppleUserCalendar(state.userId);
      synced++;
    } catch (err) {
      logger.error(`[Calendar Sync] Failed for user ${state.userId} (${state.provider}):`, err);
    }
  }
  return synced;
}

export function startCalendarSyncJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const synced = await runCalendarSync();
      if (synced > 0) logger.info(`[Calendar Sync] Synced ${synced} connected Calendar(s)`);
    } catch (err) {
      logger.error('[Calendar Sync] Failed:', err);
    }
  });
  logger.info('[Calendar Sync] Cron job registered — runs every 15 minutes');
}
```

`calendar/service.ts`: import `isEntitledBatch` from `'../billing/entitlement'` and add:
```ts
export function emptyCalendarIcs(): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rootaroo//Family Calendar//EN', 'CALSCALE:GREGORIAN', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
```
Replace `getOutlookFeedIcs`:
```ts
export async function getOutlookFeedIcs(token: string): Promise<string> {
  const state = await CalendarSyncState.findOne({ where: { outlookFeedToken: token, isActive: true } });
  if (!state) throw new AppError(404, 'Calendar feed not found');
  // §7.2: a household without entitlement gets a valid, empty calendar.
  const membership = await HouseholdMember.findOne({ where: { userId: state.userId }, attributes: ['householdId'] });
  if (!membership) return emptyCalendarIcs();
  const allowed = await isEntitledBatch([membership.householdId]);
  if (!allowed.has(membership.householdId)) return emptyCalendarIcs();
  return exportHouseholdIcs(state.userId);
}
```
In `notifyUpcomingEvents`, right after `const events = await CalendarEvent.findAll(...)`:
```ts
  const entitled = await isEntitledBatch(events.map((e) => e.householdId));
```
and as the first line inside the `for (const ev of events)` loop: `if (!entitled.has(ev.householdId)) continue;`. (Add `HouseholdMember` to the service's models import if not present.)

`server/src/shared/middleware/uploads.ts`:
```ts
import type { Express } from 'express';

export function shouldServeUploads(nodeEnv: string): boolean {
  return nodeEnv !== 'production';
}

type Layer = { name?: string; regexp?: RegExp };

/** §7.2: production serves media from S3 only; the local /uploads folder must never be exposed. */
export function assertNoUploadsInProduction(app: Express, nodeEnv: string): void {
  if (nodeEnv !== 'production') return;
  const stack: Layer[] = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  if (stack.some((l) => l.name === 'serveStatic' && l.regexp?.test('/uploads/probe.jpg'))) {
    // eslint-disable-next-line no-console
    console.error('FATAL: /uploads static serving must be disabled in production');
    process.exit(1);
  }
}
```
`app.ts`: replace the static line with:
```ts
if (shouldServeUploads(env.nodeEnv)) {
  app.use('/uploads', express.static(path.resolve(env.uploadDir || './uploads')));
}
```
`index.ts` `start()`: after `assertBillingConfigAtStartup();` add `assertNoUploadsInProduction(app, env.nodeEnv);`.

- [ ] **Step 4: Run to verify they pass**

```bash
cd server && npx jest src/jobs src/shared/middleware src/modules/calendar && npm run type-check
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src
git commit -F - <<'MSG'
feat(billing): empty ICS feed, entitlement-filtered jobs, no /uploads in production

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 4 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && npx jest --coverage --collectCoverageFrom='src/modules/billing/**/*.ts' src/modules/billing
```
Acceptance:
- All green versus baseline; `guards.int.test.ts`, `seats.int.test.ts`, `sockets.int.test.ts` pass.
- Manual check by the orchestrator with `npm run dev` and a dev user whose household has no subscription: `GET /api/v1/tasks` → 402 `SUBSCRIPTION_REQUIRED`; `GET /api/v1/households` → 200. Record in `docs/superpowers/evidence/w4-guards.md`.
- Purge jobs and job files untouched except the four listed filters (`git diff --stat` review).

---
## Wave 5: Checkout, return, sync, portal, plan change, routing (§8.1–8.3, §8.6, §12)

`upsertSubscription` (§8.4) and duplicate handling (§8.6) are built in this wave rather than W6, because the checkout sync endpoint depends on them.

### Task 5.1: Review queue and notifications

**Files:**
- Create: `server/src/modules/billing/review.ts`, `server/src/modules/billing/notify.ts`
- Test: `server/src/modules/billing/__tests__/notify.test.ts`, `server/src/modules/billing/__int__/review.int.test.ts`

**Interfaces:**
- Produces:
  - `interface ReviewInput { livemode: boolean; kind: string; entityType: string; entityId?: string | null; providerObjectId?: string | null; before?: unknown; after?: unknown; runId?: string | null }`
  - `raiseReviewItem(input: ReviewInput): Promise<BillingReconciliationItem>` (deduplicates an open `needs_review` item with the same `kind` + `providerObjectId` + `livemode`)
  - `recordAutoFix(input: ReviewInput): Promise<BillingReconciliationItem>`
  - `interface Recipient { userId: string; email: string; displayName: string }`
  - `getAdminRecipients(householdId: string, excludeUserId?: string): Promise<Recipient[]>` (admins; if none remain, every non-child member)
  - `notifyHouseholdAdmins(householdId: string, type: string, title: string, body: string, data?: Record<string, unknown>, opts?: { email?: boolean; excludeUserId?: string }): Promise<void>` (never throws)
  - `alertStaff(subject: string, text: string): Promise<void>` (never throws; subject prefixed `[Billing]`)

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/notify.test.ts`:
```ts
jest.mock('../../../database/models', () => ({ HouseholdMember: { findAll: jest.fn() }, User: {} }));
jest.mock('../../../shared/services/notifications', () => ({ notifyUser: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../shared/utils/mailer', () => ({ sendEmail: jest.fn(), sendAdminAlertEmail: jest.fn() }));

import * as models from '../../../database/models';
import { notifyUser } from '../../../shared/services/notifications';
import { sendEmail, sendAdminAlertEmail } from '../../../shared/utils/mailer';
import { getAdminRecipients, notifyHouseholdAdmins, alertStaff } from '../notify';

const m = (userId: string, role: string, email: string | null) => ({ userId, role, user: email ? { email, displayName: userId } : null });

beforeEach(() => jest.clearAllMocks());

describe('notify', () => {
  it('targets admins, excluding a given user and deleted users', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x'), m('a2', 'admin', null), m('u1', 'member', 'u1@x')]);
    expect((await getAdminRecipients('h1')).map((r) => r.userId)).toEqual(['a1']);
  });

  it('falls back to non-child members when no admin remains', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x'), m('u1', 'member', 'u1@x'), m('c1', 'child', 'c1@x')]);
    expect((await getAdminRecipients('h1', 'a1')).map((r) => r.userId)).toEqual(['u1']);
  });

  it('sends in-app and email, and survives email failures', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x')]);
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Resend down'));
    await expect(notifyHouseholdAdmins('h1', 'billing_payment_failed', 'T', 'B', { x: 1 })).resolves.toBeUndefined();
    expect(notifyUser).toHaveBeenCalledWith('a1', 'billing_payment_failed', 'T', 'B', { x: 1 });
    expect(sendEmail).toHaveBeenCalledWith('a1@x', 'T', 'B');
  });

  it('alertStaff prefixes and never throws', async () => {
    (sendAdminAlertEmail as jest.Mock).mockRejectedValue(new Error('x'));
    await expect(alertStaff('dead event', 'details')).resolves.toBeUndefined();
    expect(sendAdminAlertEmail).toHaveBeenCalledWith('[Billing] dead event', 'details');
  });
});
```

`server/src/modules/billing/__int__/review.int.test.ts`:
```ts
import { setupAssociations, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { raiseReviewItem, recordAutoFix } from '../review';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('review queue', () => {
  it('deduplicates open items by kind + object + mode and keeps the latest "after"', async () => {
    const a = await raiseReviewItem({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', after: { v: 1 } });
    const b = await raiseReviewItem({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', after: { v: 2 } });
    expect(b.id).toBe(a.id);
    expect((await BillingReconciliationItem.findByPk(a.id))!.after).toEqual({ v: 2 });
    await raiseReviewItem({ livemode: true, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1' });
    expect(await BillingReconciliationItem.count()).toBe(2);
  });

  it('records auto-fixes as separate rows', async () => {
    await recordAutoFix({ livemode: false, kind: 'subscription_drift', entityType: 'subscription', providerObjectId: 'sub_1', before: { seats: 5 }, after: { seats: 6 } });
    expect(await BillingReconciliationItem.count({ where: { resolution: 'auto_fixed' } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/notify.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`review.ts`:
```ts
import { BillingReconciliationItem } from '../../database/models';

export interface ReviewInput {
  livemode: boolean;
  kind: string;
  entityType: string;
  entityId?: string | null;
  providerObjectId?: string | null;
  before?: unknown;
  after?: unknown;
  runId?: string | null;
}

function fields(input: ReviewInput) {
  return {
    livemode: input.livemode, kind: input.kind, entityType: input.entityType, entityId: input.entityId ?? null,
    providerObjectId: input.providerObjectId ?? null, before: input.before ?? null, after: input.after ?? null, runId: input.runId ?? null,
  };
}

export async function raiseReviewItem(input: ReviewInput): Promise<BillingReconciliationItem> {
  if (input.providerObjectId) {
    const open = await BillingReconciliationItem.findOne({
      where: { kind: input.kind, providerObjectId: input.providerObjectId, livemode: input.livemode, resolution: 'needs_review' },
    });
    if (open) {
      if (input.after !== undefined) await open.update({ after: input.after });
      return open;
    }
  }
  return BillingReconciliationItem.create({ ...fields(input), resolution: 'needs_review' });
}

export async function recordAutoFix(input: ReviewInput): Promise<BillingReconciliationItem> {
  return BillingReconciliationItem.create({ ...fields(input), resolution: 'auto_fixed', resolvedBy: 'system', resolvedAt: new Date() });
}
```

`notify.ts`:
```ts
import { HouseholdMember, User } from '../../database/models';
import * as notificationService from '../../shared/services/notifications';
import { sendEmail, sendAdminAlertEmail } from '../../shared/utils/mailer';
import logger from '../../shared/utils/logger';

export interface Recipient { userId: string; email: string; displayName: string }

export async function getAdminRecipients(householdId: string, excludeUserId?: string): Promise<Recipient[]> {
  const members = await HouseholdMember.findAll({ where: { householdId }, include: [{ model: User, as: 'user', required: false }] });
  const present = members.filter((m) => m.userId !== excludeUserId && m.user);
  const admins = present.filter((m) => m.role === 'admin');
  const chosen = admins.length > 0 ? admins : present.filter((m) => m.role !== 'child');
  return chosen.map((m) => ({ userId: m.userId, email: m.user!.email, displayName: m.user!.displayName }));
}

export async function notifyHouseholdAdmins(
  householdId: string, type: string, title: string, body: string,
  data: Record<string, unknown> = {}, opts: { email?: boolean; excludeUserId?: string } = {},
): Promise<void> {
  try {
    const recipients = await getAdminRecipients(householdId, opts.excludeUserId);
    for (const r of recipients) {
      await notificationService.notifyUser(r.userId, type, title, body, data);
      if (opts.email !== false) {
        await sendEmail(r.email, title, body).catch((err: Error) =>
          logger.warn(`[Billing] email to admin ${r.userId} failed: ${err.message}`));
      }
    }
  } catch (err) {
    logger.error(`[Billing] notifyHouseholdAdmins(${householdId}, ${type}) failed:`, err);
  }
}

export async function alertStaff(subject: string, text: string): Promise<void> {
  try {
    await sendAdminAlertEmail(`[Billing] ${subject}`, text);
  } catch (err) {
    logger.error(`[Billing] staff alert failed (${subject}):`, err);
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/notify.test.ts && npm run test:int -- src/modules/billing/__int__/review.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): review queue items and admin/staff notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.2: Duplicate subscription resolution (§8.6, D3, D5)

**Files:**
- Create: `server/src/modules/billing/duplicates.ts`
- Test: `server/src/modules/billing/__tests__/duplicates.test.ts`, `server/src/modules/billing/__int__/duplicates.int.test.ts`

**Interfaces:**
- Consumes: `getStripe`, `getBillingConfig` (2.3); `raiseReviewItem`, `notifyHouseholdAdmins`, `alertStaff` (5.1); `clearEntitlementCache` (4.1).
- Produces:
  - `interface DuplicateCandidate { id: string; status: string; created: number }`
  - `chooseKeeper<T extends DuplicateCandidate>(c: T[]): { keep: T; cancel: T[] }` (active/trialing beats past_due, then oldest)
  - `resolveDuplicates(householdId: string, mode: BillingMode): Promise<{ kept: string; canceled: string[] } | null>`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/duplicates.test.ts`:
```ts
import { chooseKeeper } from '../duplicates';

describe('chooseKeeper (§8.6)', () => {
  it('prefers active/trialing over past_due', () => {
    const r = chooseKeeper([{ id: 'pd', status: 'past_due', created: 1 }, { id: 'act', status: 'active', created: 5 }]);
    expect(r.keep.id).toBe('act');
    expect(r.cancel.map((c) => c.id)).toEqual(['pd']);
  });

  it('then keeps the oldest', () => {
    const r = chooseKeeper([{ id: 'new', status: 'active', created: 9 }, { id: 'old', status: 'trialing', created: 2 }, { id: 'mid', status: 'active', created: 5 }]);
    expect(r.keep.id).toBe('old');
    expect(r.cancel.map((c) => c.id)).toEqual(['mid', 'new']);
  });
});
```

`server/src/modules/billing/__int__/duplicates.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { setupAssociations, BillingSubscription, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { resolveDuplicates } from '../duplicates';
import { alertStaff, notifyHouseholdAdmins } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('resolveDuplicates (D3)', () => {
  it('keeps the healthy subscription, cancels and refunds the other, raises review', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_old', status: 'active' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_new', status: 'active' });
    const inv = stripeInvoice({ id: 'in_new', status: 'paid', amountPaid: 899 });
    s.subscriptions.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_old' ? stripeSubscription({ id, created: 100 }) : stripeSubscription({ id, created: 200, latestInvoice: inv }));
    s.subscriptions.cancel.mockResolvedValue({ ...stripeSubscription({ id: 'sub_new', status: 'canceled' }), canceled_at: 300, ended_at: 300 });
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_new' } } }]));
    s.refunds.create.mockResolvedValue({ id: 're_1' });

    await expect(resolveDuplicates(household.id, 'test')).resolves.toEqual({ kept: 'sub_old', canceled: ['sub_new'] });
    expect(s.subscriptions.cancel).toHaveBeenCalledWith('sub_new', { prorate: false }, { idempotencyKey: 'dupcancel:sub_new' });
    expect(s.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_new', reason: 'duplicate' }), { idempotencyKey: 'dup:sub_new' });
    expect((await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_new' } }))!.status).toBe('canceled');
    expect(await BillingReconciliationItem.count({ where: { kind: 'duplicate_subscription', resolution: 'needs_review' } })).toBe(1);
    expect(alertStaff).toHaveBeenCalled();
    expect(notifyHouseholdAdmins).toHaveBeenCalled();
  });

  it('cross-provider duplicates only raise a review item and tell the admin (D5)', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_1' });
    await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000123' });
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
    expect(s.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await BillingReconciliationItem.count({ where: { kind: 'cross_provider_duplicate' } })).toBe(1);
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_duplicate_store', expect.any(String), expect.any(String), {}, { email: true });
  });

  it('does nothing for a single subscription or when Stripe shows only one allowed', async () => {
    const s = installStripeMock('test');
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_a' });
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_b' });
    s.subscriptions.retrieve.mockImplementation(async (id: string) => stripeSubscription({ id, status: id === 'sub_b' ? 'canceled' : 'active' }));
    await expect(resolveDuplicates(household.id, 'test')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/duplicates.test.ts` → FAIL.

- [ ] **Step 3: Implement `duplicates.ts`**

```ts
import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { clearEntitlementCache } from './entitlement';
import { livemodeOf } from './mode';
import { alertStaff, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { ALLOWED_STATUSES, BillingMode } from './types';

export interface DuplicateCandidate { id: string; status: string; created: number }

export function chooseKeeper<T extends DuplicateCandidate>(c: T[]): { keep: T; cancel: T[] } {
  const rank = (s: T) => (s.status === 'active' || s.status === 'trialing' ? 0 : 1);
  const sorted = [...c].sort((a, b) => rank(a) - rank(b) || a.created - b.created);
  return { keep: sorted[0], cancel: sorted.slice(1) };
}

const isAllowed = (s: string) => (ALLOWED_STATUSES as readonly string[]).includes(s);

async function refundLatestPaid(stripe: Stripe, sub: Stripe.Subscription, householdId: string, livemode: boolean): Promise<void> {
  const inv = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  if (!inv || inv.status !== 'paid' || !inv.amount_paid) return;
  // Verify at implementation time: https://docs.stripe.com/api/invoice-payment/list.md (invoice filter, expand path).
  const payments = await stripe.invoicePayments.list({ invoice: inv.id!, limit: 10, expand: ['data.payment.payment_intent'] });
  const paid = payments.data.find((p) => p.status === 'paid');
  const pi = paid?.payment?.payment_intent;
  const piId = typeof pi === 'string' ? pi : pi?.id;
  if (!piId) {
    await raiseReviewItem({ livemode, kind: 'duplicate_refund_missing', entityType: 'subscription', providerObjectId: sub.id });
    return;
  }
  await stripe.refunds.create(
    { payment_intent: piId, reason: 'duplicate', metadata: { householdId, env: getBillingConfig().envTag, reason: 'duplicate_subscription', subscription: sub.id } },
    { idempotencyKey: `dup:${sub.id}` },
  );
}

/** §8.6: run after every upsert. Never calls upsertSubscription (no recursion). */
export async function resolveDuplicates(householdId: string, mode: BillingMode): Promise<{ kept: string; canceled: string[] } | null> {
  const livemode = livemodeOf(mode);
  const rows = await BillingSubscription.findAll({ where: { householdId, livemode, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  if (rows.length <= 1) return null;

  if (rows.some((r) => r.provider !== 'stripe')) {
    await raiseReviewItem({
      livemode, kind: 'cross_provider_duplicate', entityType: 'household', entityId: householdId,
      providerObjectId: rows.map((r) => r.providerSubscriptionId).sort().join(','),
      after: rows.map((r) => ({ provider: r.provider, id: r.providerSubscriptionId, status: r.status })),
    });
    await notifyHouseholdAdmins(householdId, 'billing_duplicate_store', 'Your household has two Rootaroo subscriptions',
      'Your household is subscribed through more than one store. Cancel the extra one in your App Store or Google Play subscription settings. Contact support if you need a refund.',
      {}, { email: true });
    return null;
  }

  const stripe = getStripe(mode);
  // A subscription Stripe no longer knows is reconciliation's job (missing_in_stripe), not a duplicate.
  const fresh = (await Promise.all(rows.map((r) => stripe.subscriptions.retrieve(r.providerSubscriptionId, { expand: ['latest_invoice'] })
    .catch((err: { code?: string }) => { if (err.code === 'resource_missing') return null; throw err; }))))
    .filter((x): x is Stripe.Subscription => x !== null);
  const allowed = fresh.filter((s) => isAllowed(s.status));
  if (allowed.length <= 1) return null; // local rows are stale; their own upserts correct them

  const { keep, cancel } = chooseKeeper(allowed);
  for (const sub of cancel) {
    const canceled = await stripe.subscriptions.cancel(sub.id, { prorate: false }, { idempotencyKey: `dupcancel:${sub.id}` });
    await BillingSubscription.update(
      {
        status: canceled.status,
        canceledAt: canceled.canceled_at ? new Date(canceled.canceled_at * 1000) : new Date(),
        endedAt: canceled.ended_at ? new Date(canceled.ended_at * 1000) : new Date(),
        graceUntil: null,
      },
      { where: { provider: 'stripe', livemode, providerSubscriptionId: sub.id } },
    );
    try {
      await refundLatestPaid(stripe, sub, householdId, livemode);
    } catch (err) {
      logger.error(`[Billing] duplicate refund failed for ${sub.id}:`, err);
      await raiseReviewItem({ livemode, kind: 'duplicate_refund_failed', entityType: 'subscription', providerObjectId: sub.id, after: { error: (err as Error).message } });
    }
  }

  const canceled = cancel.map((c) => c.id);
  await raiseReviewItem({
    livemode, kind: 'duplicate_subscription', entityType: 'household', entityId: householdId,
    providerObjectId: [keep.id, ...canceled].join(','), after: { kept: keep.id, canceled },
  });
  await alertStaff('Duplicate subscription resolved', `Household ${householdId}: kept ${keep.id}, canceled and refunded ${canceled.join(', ')}.`);
  await notifyHouseholdAdmins(householdId, 'billing_duplicate_refunded', 'We refunded a duplicate subscription',
    'Your household was charged for two subscriptions. We kept one and refunded the other in full.', {}, { email: true });
  await clearEntitlementCache(householdId);
  return { kept: keep.id, canceled };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/duplicates.test.ts && npm run test:int -- src/modules/billing/__int__/duplicates.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): resolve duplicate subscriptions with cancel, refund and review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.3: `upsertSubscription`, the only writer of subscription state (§8.4, §7.1 grace)

**Files:**
- Create: `server/src/modules/billing/sync.ts`
- Test: `server/src/modules/billing/__tests__/sync.test.ts`, `server/src/modules/billing/__int__/sync.int.test.ts`

**Interfaces:**
- Consumes: `withLock` (2.4); `getStripe`, `getBillingConfig` (2.3); `raiseReviewItem` (5.1); `resolveDuplicates` (5.2); `clearEntitlementCache` (4.1).
- Produces:
  - `interface MappedSubscription { status: SubscriptionStatus; interval: BillingInterval; seats: number | null; priceId: string | null; priceSet: string | null; unitAmount: number | null; currency: string | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; canceledAt: Date | null; endedAt: Date | null; pendingUpdate: Record<string, unknown> | null; customerId: string; metadata: Record<string, string> }`
  - `mapStripeSubscription(sub: Stripe.Subscription): MappedSubscription` (pure; period from `items.data[0].current_period_*`)
  - `computeGraceUntil(status: SubscriptionStatus, existing: Date | null, latestInvoice: Stripe.Invoice | string | null, graceDays: number): Date | null` (pure)
  - `resolveHouseholdForSubscription(mapped: MappedSubscription, mode: BillingMode): Promise<{ householdId: string; via: 'customer' | 'metadata' } | null>`
  - `upsertSubscription(subId: string, mode: BillingMode, opts?: { eventCreated?: number }): Promise<BillingSubscription | null>`
  - `idOf(x: string | { id: string } | null | undefined): string | null`

- [ ] **Step 1: Write the failing unit tests**

`server/src/modules/billing/__tests__/sync.test.ts`:
```ts
import { mapStripeSubscription, computeGraceUntil } from '../sync';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';

describe('mapStripeSubscription', () => {
  it('reads price, seats, set, amount and the item-level period', () => {
    const sub = stripeSubscription({ seats: 7, interval: 'year', periodStart: 1_700_000_000, periodEnd: 1_731_536_000, customer: 'cus_9', cancelAtPeriodEnd: true });
    const m = mapStripeSubscription(sub);
    expect(m).toMatchObject({
      status: 'active', interval: 'year', seats: 7, priceSet: '2026-10', unitAmount: 12775, currency: 'usd',
      cancelAtPeriodEnd: true, customerId: 'cus_9', pendingUpdate: null,
    });
    expect(m.currentPeriodStart!.getTime()).toBe(1_700_000_000_000);
    expect(m.currentPeriodEnd!.getTime()).toBe(1_731_536_000_000);
  });

  it('falls back to the lookup key for seats and returns null when unknown', () => {
    const sub = stripeSubscription({ seats: 9 });
    (sub.items.data[0].price as any).metadata = {};
    expect(mapStripeSubscription(sub).seats).toBe(9);
    (sub.items.data[0].price as any).lookup_key = null;
    expect(mapStripeSubscription(sub).seats).toBeNull();
  });

  it('keeps pending_update', () => {
    expect(mapStripeSubscription(stripeSubscription({ pendingUpdate: { expires_at: 5 } })).pendingUpdate).toEqual({ expires_at: 5 });
  });
});

describe('computeGraceUntil (§7.1, T7)', () => {
  const inv = stripeInvoice({ created: 1_000_000, finalizedAt: 1_000_600 });

  it('starts at finalized_at + grace days on first past_due', () => {
    expect(computeGraceUntil('past_due', null, inv, 7)!.getTime()).toBe((1_000_600 + 7 * 86400) * 1000);
  });

  it('falls back to invoice.created when not finalized', () => {
    expect(computeGraceUntil('past_due', null, stripeInvoice({ created: 2_000_000, finalizedAt: null }), 7)!.getTime()).toBe((2_000_000 + 7 * 86400) * 1000);
  });

  it('keeps an existing grace while still past_due', () => {
    const existing = new Date('2026-10-20T00:00:00Z');
    expect(computeGraceUntil('past_due', existing, inv, 7)).toBe(existing);
  });

  it.each(['active', 'trialing', 'unpaid', 'canceled', 'incomplete'] as const)('clears grace for %s', (status) => {
    expect(computeGraceUntil(status, new Date(), inv, 7)).toBeNull();
  });

  it('returns null when latest_invoice is not expanded', () => {
    expect(computeGraceUntil('past_due', null, 'in_1', 7)).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing integration tests (T1, T5, linking, env, soft-deleted household)**

`server/src/modules/billing/__int__/sync.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { setupAssociations, BillingSubscription, BillingReconciliationItem, BillingCustomer, Household } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { upsertSubscription } from '../sync';
import { getEntitlement } from '../entitlement';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

describe('upsertSubscription', () => {
  it('creates the row via billing_customers, sets purchaser on insert only, unlocks', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_A' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', customer: 'cus_A', seats: 6, purchasedByUserId: admin.id }));
    const row = await upsertSubscription('sub_A', 'test', { eventCreated: 50 });
    expect(row).toMatchObject({ householdId: household.id, seats: 6, status: 'active', purchasedByUserId: admin.id, eventWatermark: 50 });
    expect(s.subscriptions.retrieve).toHaveBeenCalledWith('sub_A', { expand: ['items.data.price', 'latest_invoice'] });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(true);

    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', customer: 'cus_A', seats: 6, purchasedByUserId: 'someone-else' }));
    const again = await upsertSubscription('sub_A', 'test', { eventCreated: 40 });
    expect(again!.purchasedByUserId).toBe(admin.id);
    expect(again!.eventWatermark).toBe(50);
  });

  it('recovers the household from metadata when the customer row is missing, and recreates it', async () => {
    const { household } = await createHouseholdWithAdmin();
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_M', customer: 'cus_M', householdId: household.id }));
    expect((await upsertSubscription('sub_M', 'test'))!.householdId).toBe(household.id);
    expect(await BillingCustomer.count({ where: { providerCustomerId: 'cus_M' } })).toBe(1);
  });

  it('unmatched subscription: review item, no row', async () => {
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_X', customer: 'cus_X' }));
    expect(await upsertSubscription('sub_X', 'test')).toBeNull();
    expect(await BillingSubscription.count()).toBe(0);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_subscription' } })).toBe(1);
  });

  it('ignores another environment (env tag) and never writes', async () => {
    const { household } = await createHouseholdWithAdmin();
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_E', householdId: household.id, env: 'staging' }));
    expect(await upsertSubscription('sub_E', 'test')).toBeNull();
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('refuses a livemode mismatch (B3)', async () => {
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_L', livemode: true }));
    await expect(upsertSubscription('sub_L', 'test')).rejects.toThrow(/livemode/);
  });

  it('computes grace on past_due and clears it on recovery', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_G' });
    const now = Math.floor(Date.now() / 1000);
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_G', customer: 'cus_G', status: 'past_due', latestInvoice: stripeInvoice({ status: 'open', finalizedAt: now }) }));
    const pd = await upsertSubscription('sub_G', 'test');
    expect(pd!.graceUntil!.getTime()).toBe((now + 7 * 86400) * 1000);
    expect(await getEntitlement(household.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'grace' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_G', customer: 'cus_G', status: 'active' }));
    expect((await upsertSubscription('sub_G', 'test'))!.graceUntil).toBeNull();
  });

  it('T5/T1: out-of-order and concurrent calls converge on the fresh Stripe state', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T', customer: 'cus_T', seats: 8, cancelAtPeriodEnd: true }));
    await Promise.all([upsertSubscription('sub_T', 'test', { eventCreated: 20 }), upsertSubscription('sub_T', 'test', { eventCreated: 10 })]);
    const rows = await BillingSubscription.findAll({ where: { providerSubscriptionId: 'sub_T' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seats: 8, cancelAtPeriodEnd: true, eventWatermark: 20 });
  });

  it('still links late events for a soft-deleted household (§8.7)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_D' });
    await Household.destroy({ where: { id: household.id } });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_D', customer: 'cus_D', status: 'canceled' }));
    expect((await upsertSubscription('sub_D', 'test'))!.householdId).toBe(household.id);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/sync.test.ts` → FAIL.

- [ ] **Step 4: Implement `sync.ts`**

```ts
import Stripe from 'stripe';
import { UniqueConstraintError } from 'sequelize';
import { BillingCustomer, BillingSubscription, Household, User } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { resolveDuplicates } from './duplicates';
import { clearEntitlementCache } from './entitlement';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { raiseReviewItem } from './review';
import type { BillingInterval, BillingMode, SubscriptionStatus } from './types';

export interface MappedSubscription {
  status: SubscriptionStatus;
  interval: BillingInterval;
  seats: number | null;
  priceId: string | null;
  priceSet: string | null;
  unitAmount: number | null;
  currency: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  pendingUpdate: Record<string, unknown> | null;
  customerId: string;
  metadata: Record<string, string>;
}

export function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

const toDate = (sec: number | null | undefined): Date | null => (typeof sec === 'number' ? new Date(sec * 1000) : null);

function seatsOf(price: Stripe.Price | undefined): number | null {
  const fromMeta = Number(price?.metadata?.seats);
  if (Number.isInteger(fromMeta) && fromMeta >= 5 && fromMeta <= 10) return fromMeta;
  const m = /^rootaroo_hh(\d+)_(month|year)$/.exec(price?.lookup_key ?? '');
  const fromKey = m ? Number(m[1]) : NaN;
  return Number.isInteger(fromKey) && fromKey >= 5 && fromKey <= 10 ? fromKey : null;
}

export function mapStripeSubscription(sub: Stripe.Subscription): MappedSubscription {
  const item = sub.items.data[0];
  const price = item?.price;
  return {
    status: sub.status as SubscriptionStatus,
    interval: price?.recurring?.interval === 'year' ? 'year' : 'month',
    seats: seatsOf(price),
    priceId: price?.id ?? null,
    priceSet: price?.metadata?.price_set ?? null,
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? null,
    currentPeriodStart: toDate(item?.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: toDate(sub.canceled_at),
    endedAt: toDate(sub.ended_at),
    pendingUpdate: sub.pending_update ? (sub.pending_update as unknown as Record<string, unknown>) : null,
    customerId: idOf(sub.customer as string | { id: string })!,
    metadata: (sub.metadata ?? {}) as Record<string, string>,
  };
}

export function computeGraceUntil(
  status: SubscriptionStatus, existing: Date | null, latestInvoice: Stripe.Invoice | string | null, graceDays: number,
): Date | null {
  if (status !== 'past_due') return null;
  if (existing) return existing;
  if (!latestInvoice || typeof latestInvoice === 'string') return null;
  const base = latestInvoice.status_transitions?.finalized_at ?? latestInvoice.created;
  return new Date((base + graceDays * 86400) * 1000);
}

export async function resolveHouseholdForSubscription(
  mapped: MappedSubscription, mode: BillingMode,
): Promise<{ householdId: string; via: 'customer' | 'metadata' } | null> {
  const livemode = livemodeOf(mode);
  const cust = await BillingCustomer.findOne({ where: { provider: 'stripe', livemode, providerCustomerId: mapped.customerId } });
  if (cust) return { householdId: cust.householdId, via: 'customer' };
  const hh = mapped.metadata.householdId;
  if (hh && mapped.metadata.env === getBillingConfig().envTag) {
    const household = await Household.findByPk(hh, { paranoid: false, attributes: ['id'] });
    if (household) return { householdId: household.id, via: 'metadata' };
  }
  return null;
}

async function validPurchaser(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = await User.findByPk(userId, { paranoid: false, attributes: ['id'] });
  return user ? user.id : null;
}

async function ensureCustomerRow(householdId: string, customerId: string, livemode: boolean): Promise<void> {
  try {
    await BillingCustomer.findOrCreate({
      where: { householdId, provider: 'stripe', livemode },
      defaults: { householdId, provider: 'stripe', livemode, providerCustomerId: customerId },
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
  }
}

/**
 * §8.4: the only code that writes subscription state. Fetches fresh state inside a
 * per-subscription lock, so the last writer always writes the newest Stripe state.
 */
export async function upsertSubscription(
  subId: string, mode: BillingMode, opts: { eventCreated?: number } = {},
): Promise<BillingSubscription | null> {
  const row = await withLock(`billing:sub:${subId}`, 30_000, async () => {
    const cfg = getBillingConfig();
    const livemode = livemodeOf(mode);
    const sub = await getStripe(mode).subscriptions.retrieve(subId, { expand: ['items.data.price', 'latest_invoice'] });
    if (sub.livemode !== livemode) throw new Error(`livemode mismatch for ${subId}`);
    const mapped = mapStripeSubscription(sub);
    if (mapped.metadata.env && mapped.metadata.env !== cfg.envTag) {
      logger.info(`[Billing] ignoring ${subId}: env ${mapped.metadata.env} != ${cfg.envTag}`);
      return null;
    }

    const link = await resolveHouseholdForSubscription(mapped, mode);
    if (!link) {
      await raiseReviewItem({ livemode, kind: 'unmatched_subscription', entityType: 'subscription', providerObjectId: subId, after: { customer: mapped.customerId, metadata: mapped.metadata } });
      return null;
    }
    if (link.via === 'metadata') await ensureCustomerRow(link.householdId, mapped.customerId, livemode);

    if (mapped.seats === null) {
      await raiseReviewItem({ livemode, kind: 'unknown_price', entityType: 'subscription', providerObjectId: subId, after: { priceId: mapped.priceId } });
    }

    const existing = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
    const fields = {
      householdId: link.householdId,
      status: mapped.status,
      interval: mapped.interval,
      seats: mapped.seats ?? existing?.seats ?? 5,
      priceId: mapped.priceId,
      priceSet: mapped.priceSet,
      unitAmount: mapped.unitAmount,
      currency: mapped.currency,
      currentPeriodStart: mapped.currentPeriodStart,
      currentPeriodEnd: mapped.currentPeriodEnd,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
      canceledAt: mapped.canceledAt,
      endedAt: mapped.endedAt,
      pendingUpdate: mapped.pendingUpdate,
      graceUntil: computeGraceUntil(mapped.status, existing?.graceUntil ?? null, sub.latest_invoice as Stripe.Invoice | string | null, cfg.graceDays),
      eventWatermark: Math.max(Number(existing?.eventWatermark ?? 0), opts.eventCreated ?? 0) || null,
      lastSyncedAt: new Date(),
    };

    if (existing) return existing.update(fields);
    try {
      return await BillingSubscription.create({
        ...fields, provider: 'stripe', livemode, providerSubscriptionId: subId,
        purchasedByUserId: await validPurchaser(mapped.metadata.purchasedByUserId),
      });
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
      const raced = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
      return raced!.update(fields);
    }
  }, { waitMs: 15_000 });

  if (row) {
    await clearEntitlementCache(row.householdId);
    await resolveDuplicates(row.householdId, mode);
  }
  return row;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/sync.test.ts && npm run test:int -- src/modules/billing/__int__/sync.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): upsertSubscription under per-subscription lock with grace and linking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.4: Routing rules (§12)

**Files:**
- Create: `server/src/modules/billing/routing.ts`
- Test: `server/src/modules/billing/__tests__/routing.test.ts`, `server/src/modules/billing/__int__/routing.int.test.ts`

**Interfaces:**
- Produces:
  - `interface RuleRow { platform: ClientPlatform; country: string; method: PurchaseMethod }`
  - `normalizePlatform(v: unknown): ClientPlatform` (unknown → `'web'`), `normalizeCountry(v: unknown): string` (invalid → `'ZZ'`), `parseClientContext(req: Request): ClientContext` (headers `X-Platform`, `X-Store-Country`)
  - `matchRule(rules: RuleRow[], platform: ClientPlatform, country: string): PurchaseMethod` (exact → `(platform,'*')` → `'none'`)
  - `loadRules(): Promise<RuleRow[]>` (60 s in-process cache), `clearRoutingCache(): void`
  - `resolvePurchaseMethod(ctx: ClientContext, cohort: BillingCohort): Promise<PurchaseMethod>` (test cohort → `'stripe_checkout'`)
  - `isStripeCheckoutAllowed(method: PurchaseMethod, cohort: BillingCohort, nodeEnv?: string): boolean`
  - `validateRules(rules: RuleRow[]): void` (throws `ValidationError`), `replaceRoutingRules(rules: RuleRow[], updatedBy: string): Promise<RuleRow[]>` (one transaction), `seedDefaultRoutingRules(nodeEnv?: string): Promise<void>` (tests)

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/routing.test.ts`:
```ts
import { matchRule, normalizeCountry, normalizePlatform, isStripeCheckoutAllowed, validateRules, RuleRow } from '../routing';

const PROD: RuleRow[] = [
  { platform: 'ios', country: 'US', method: 'stripe_checkout' },
  { platform: 'android', country: 'US', method: 'stripe_checkout' },
  { platform: 'ios', country: '*', method: 'apple_iap' },
  { platform: 'android', country: '*', method: 'google_play' },
  { platform: 'web', country: '*', method: 'stripe_checkout' },
];

describe('routing resolution (§12)', () => {
  it.each([
    ['ios', 'US', 'stripe_checkout'], ['ios', 'GB', 'apple_iap'], ['android', 'US', 'stripe_checkout'],
    ['android', 'NP', 'google_play'], ['web', 'ZZ', 'stripe_checkout'], ['ios', 'ZZ', 'apple_iap'],
  ] as const)('%s/%s -> %s', (p, c, m) => expect(matchRule(PROD, p, c)).toBe(m));

  it('falls through to none', () => {
    expect(matchRule([{ platform: 'ios', country: 'US', method: 'stripe_checkout' }], 'android', 'US')).toBe('none');
  });

  it('normalizes headers', () => {
    expect(normalizePlatform('IOS')).toBe('ios');
    expect(normalizePlatform('windows')).toBe('web');
    expect(normalizePlatform(undefined)).toBe('web');
    expect(normalizeCountry('us')).toBe('US');
    expect(normalizeCountry('USA')).toBe('ZZ');
    expect(normalizeCountry(undefined)).toBe('ZZ');
  });

  it('allows Stripe checkout for the test cohort and outside production', () => {
    expect(isStripeCheckoutAllowed('apple_iap', 'live', 'production')).toBe(false);
    expect(isStripeCheckoutAllowed('apple_iap', 'test', 'production')).toBe(true);
    expect(isStripeCheckoutAllowed('none', 'live', 'development')).toBe(true);
    expect(isStripeCheckoutAllowed('stripe_checkout', 'live', 'production')).toBe(true);
  });

  it('validates rule sets', () => {
    expect(() => validateRules(PROD)).not.toThrow();
    expect(() => validateRules([...PROD, PROD[0]])).toThrow(/duplicate/);
    expect(() => validateRules([{ platform: 'ios', country: 'usa', method: 'apple_iap' }])).toThrow(/country/);
    expect(() => validateRules([{ platform: 'tv' as any, country: '*', method: 'apple_iap' }])).toThrow(/platform/);
  });
});
```

`server/src/modules/billing/__int__/routing.int.test.ts`:
```ts
import { setupAssociations, BillingRoutingRule } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { replaceRoutingRules, resolvePurchaseMethod, clearRoutingCache, seedDefaultRoutingRules } from '../routing';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); clearRoutingCache(); });
afterAll(() => closeIntResources());

describe('routing rules in MySQL', () => {
  it('replaces the whole rule set and refreshes resolution', async () => {
    await seedDefaultRoutingRules('development');
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'live')).toBe('stripe_checkout');
    await replaceRoutingRules([{ platform: 'ios', country: '*', method: 'apple_iap' }], 'staff:test');
    expect(await BillingRoutingRule.count()).toBe(1);
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'live')).toBe('apple_iap');
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'test')).toBe('stripe_checkout');
  });

  it('rolls back on an invalid set', async () => {
    await seedDefaultRoutingRules('development');
    await expect(replaceRoutingRules([{ platform: 'ios', country: 'XXX', method: 'apple_iap' }], 's')).rejects.toThrow();
    expect(await BillingRoutingRule.count()).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/routing.test.ts` → FAIL.

- [ ] **Step 3: Implement `routing.ts`**

```ts
import { Request } from 'express';
import { sequelize, BillingRoutingRule } from '../../database/models';
import { env } from '../../config/env';
import { ValidationError } from '../../shared/utils/errors';
import type { BillingCohort, ClientContext, ClientPlatform, PurchaseMethod } from './types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defaultRoutingRules } = require('../../database/billingSeeds');

export interface RuleRow { platform: ClientPlatform; country: string; method: PurchaseMethod }

const PLATFORMS: ClientPlatform[] = ['ios', 'android', 'web'];
const METHODS: PurchaseMethod[] = ['stripe_checkout', 'apple_iap', 'google_play', 'none'];
const RULE_TTL_MS = 60_000;
let cache: { rules: RuleRow[]; expires: number } | null = null;

export function normalizePlatform(v: unknown): ClientPlatform {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (PLATFORMS as string[]).includes(p) ? (p as ClientPlatform) : 'web';
}

export function normalizeCountry(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : 'ZZ';
}

export function parseClientContext(req: Request): ClientContext {
  return { platform: normalizePlatform(req.header('x-platform')), country: normalizeCountry(req.header('x-store-country')) };
}

export function matchRule(rules: RuleRow[], platform: ClientPlatform, country: string): PurchaseMethod {
  return rules.find((r) => r.platform === platform && r.country === country)?.method
    ?? rules.find((r) => r.platform === platform && r.country === '*')?.method
    ?? 'none';
}

export function clearRoutingCache(): void { cache = null; }

export async function loadRules(): Promise<RuleRow[]> {
  if (cache && cache.expires > Date.now()) return cache.rules;
  const rows = await BillingRoutingRule.findAll();
  const rules = rows.map((r) => ({ platform: r.platform, country: r.country, method: r.method }));
  cache = { rules, expires: Date.now() + RULE_TTL_MS };
  return rules;
}

export async function resolvePurchaseMethod(ctx: ClientContext, cohort: BillingCohort): Promise<PurchaseMethod> {
  const method = matchRule(await loadRules(), ctx.platform, ctx.country);
  // §12: the test cohort can always test Stripe checkout, on any platform.
  return cohort === 'test' ? 'stripe_checkout' : method;
}

export function isStripeCheckoutAllowed(method: PurchaseMethod, cohort: BillingCohort, nodeEnv: string = env.nodeEnv): boolean {
  return method === 'stripe_checkout' || cohort === 'test' || nodeEnv !== 'production';
}

export function validateRules(rules: RuleRow[]): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!PLATFORMS.includes(r.platform)) throw new ValidationError(`invalid platform ${String(r.platform)}`);
    if (!(r.country === '*' || /^[A-Z]{2}$/.test(r.country))) throw new ValidationError(`invalid country ${r.country}`);
    if (!METHODS.includes(r.method)) throw new ValidationError(`invalid method ${String(r.method)}`);
    const key = `${r.platform}:${r.country}`;
    if (seen.has(key)) throw new ValidationError(`duplicate rule ${key}`);
    seen.add(key);
  }
}

export async function replaceRoutingRules(rules: RuleRow[], updatedBy: string): Promise<RuleRow[]> {
  validateRules(rules);
  await sequelize.transaction(async (transaction) => {
    await BillingRoutingRule.destroy({ where: {}, transaction });
    await BillingRoutingRule.bulkCreate(rules.map((r) => ({ ...r, updatedBy })), { transaction });
  });
  clearRoutingCache();
  return rules;
}

export async function seedDefaultRoutingRules(nodeEnv = 'development'): Promise<void> {
  await BillingRoutingRule.bulkCreate((defaultRoutingRules(nodeEnv) as RuleRow[]).map((r) => ({ ...r, updatedBy: 'seed' })));
  clearRoutingCache();
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/routing.test.ts && npm run test:int -- src/modules/billing/__int__/routing.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): server-side purchase routing rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.5: `POST /billing/checkout` (§8.1)

**Files:**
- Create: `server/src/modules/billing/checkout.ts`, `server/src/modules/billing/copy.ts`, `server/src/modules/billing/portal.ts`
- Modify: `server/src/modules/billing/controller.ts`, `server/src/modules/billing/routes.ts`
- Test: `server/src/modules/billing/__tests__/copy.test.ts`, `server/src/modules/billing/__int__/checkout.int.test.ts`

**Interfaces:**
- Consumes: `requireAdminContext` (3.3); `getCatalog`, `priceFor`, `assertSeats` (3.1); `withLock` (2.4); `resolvePurchaseMethod`, `isStripeCheckoutAllowed`, `parseClientContext` (5.4); `upsertSubscription`, `idOf` (5.3).
- Produces:
  - `copy.ts`: `formatUsd(cents: number): string`, `autoRenewDisclosure(cents: number, interval: BillingInterval): string`
  - `portal.ts`: `getPortalConfigurationId(mode): Promise<string | undefined>`, `createPortalUrl(mode, customerId): Promise<string>`, `__clearPortalCacheForTests(): void`
  - `checkout.ts`: `interface CheckoutBody { interval: BillingInterval; seats: number }`, `interface CheckoutResult { url: string; sessionId: string }`, `CHECKOUT_SESSION_TTL_SEC = 31 * 60`, `checkoutLockName(householdId, mode): string`, `paymentIssueError(mode, customerId): Promise<BillingConflictError>`, `findOrCreateCustomer(household: Household, mode: BillingMode, admin: User): Promise<string>`, `createCheckout(userId: string, body: CheckoutBody, client: ClientContext, now?: Date): Promise<CheckoutResult>`
  - Route `POST /api/v1/billing/checkout` → `200 { success, data: { url, sessionId } }`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/copy.test.ts`:
```ts
import { autoRenewDisclosure, formatUsd } from '../copy';

describe('copy', () => {
  it('formats cents and the auto-renewal disclosure (§7.4, §9)', () => {
    expect(formatUsd(12775)).toBe('$127.75');
    expect(autoRenewDisclosure(899, 'month')).toBe('Renews automatically at $8.99 per month until cancelled. Cancel anytime in Manage subscription.');
  });
});
```

`server/src/modules/billing/__int__/checkout.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingCheckoutSession, BillingCustomer } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { catalogPrices, stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { seedDefaultRoutingRules } from '../routing';
import { __clearPortalCacheForTests } from '../portal';

let s: StripeMock;
const post = (user: any, body: unknown) => request(app).post('/api/v1/billing/checkout').set(authHeaderFor(user)).send(body);

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  await seedDefaultRoutingRules('development');
  clearLocalCatalogCache();
  __clearPortalCacheForTests();
  s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
  s.customers.create.mockResolvedValue({ id: 'cus_new', email: 'a@x' });
  s.checkout.sessions.create.mockImplementation(async () => stripeCheckoutSession({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }));
  s.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
});
afterAll(() => closeIntResources());

describe('POST /billing/checkout', () => {
  it('creates a session with server-chosen price and every required parameter (B4, B9)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const res = await post(admin, { interval: 'year', seats: 7, price: 'price_evil', quantity: 3, payment_method_types: ['card'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc', sessionId: 'cs_test_abc' });
    const [params, opts] = s.checkout.sessions.create.mock.calls[0] as any[];
    expect(params).toMatchObject({
      mode: 'subscription', customer: 'cus_new', client_reference_id: household.id,
      line_items: [{ price: 'price_202610_7_year', quantity: 1 }],
      subscription_data: { metadata: { householdId: household.id, purchasedByUserId: admin.id, env: 'dev' } },
      metadata: { householdId: household.id, env: 'dev' }, origin_context: 'mobile_app', allow_promotion_codes: false,
      consent_collection: { terms_of_service: 'required' },
      custom_text: { submit: { message: 'Renews automatically at $127.75 per year until cancelled. Cancel anytime in Manage subscription.' } },
      success_url: 'https://api.example.test/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://api.example.test/api/v1/billing/return/cancel',
      integration_identifier: 'rootaroo_app_checkout_qhzmvtkd',
    });
    expect(params).not.toHaveProperty('payment_method_types');
    expect(params.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
    const row = await BillingCheckoutSession.findOne({ where: { householdId: household.id } });
    expect(row).toMatchObject({ status: 'open', providerSessionId: 'cs_test_abc', seats: 7, interval: 'year' });
    expect(opts).toEqual({ idempotencyKey: `cs:${row!.id}` });
    expect(s.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: admin.email, metadata: { householdId: household.id, env: 'dev' } }),
      { idempotencyKey: `cust:${household.id}:test:${admin.id}` },
    );
  });

  it('403 for a non-admin (B6)', async () => {
    const { household } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    expect((await post(member, { interval: 'month', seats: 5 })).status).toBe(403);
  });

  it('400 for out-of-range seats', async () => {
    const { admin } = await createHouseholdWithAdmin();
    expect((await post(admin, { interval: 'month', seats: 11 })).status).toBe(400);
    expect((await post(admin, { interval: 'week', seats: 5 })).status).toBe(400);
  });

  it('409 SEATS_BELOW_MEMBERS with memberCount (L5)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    for (let i = 0; i < 6; i++) await addMember(household.id);
    const res = await post(admin, { interval: 'month', seats: 6 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 7 });
  });

  it('rejects an 11-member household for every size (Review Focus 3)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    for (let i = 0; i < 10; i++) await addMember(household.id);
    const res = await post(admin, { interval: 'month', seats: 10 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 11 });
  });

  it('409 ALREADY_SUBSCRIBED from a local active subscription (D2)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    expect((await post(admin, { interval: 'month', seats: 5 })).body.code).toBe('ALREADY_SUBSCRIBED');
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('syncs a Stripe-side active subscription then 409 (D2 stale local state)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_S' });
    const sub = stripeSubscription({ id: 'sub_S', customer: 'cus_S' });
    s.subscriptions.list.mockReturnValue(listOf([sub]));
    s.subscriptions.retrieve.mockResolvedValue(sub);
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(s.subscriptions.retrieve).toHaveBeenCalledWith('sub_S', expect.anything());
  });

  it('409 PAYMENT_ISSUE with a portal URL while past_due (D2)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_P' });
    s.subscriptions.list.mockReturnValue(listOf([stripeSubscription({ id: 'sub_P', customer: 'cus_P', status: 'past_due' })]));
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PAYMENT_ISSUE', portalUrl: 'https://billing.stripe.com/p/session/x' });
  });

  it('reuses an open session with the same plan and expires one with a different plan (D1)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    await post(admin, { interval: 'month', seats: 5 });
    const again = await post(admin, { interval: 'month', seats: 5 });
    expect(again.body.data.sessionId).toBe('cs_test_abc');
    expect(s.checkout.sessions.create).toHaveBeenCalledTimes(1);
    s.checkout.sessions.create.mockImplementation(async () => stripeCheckoutSession({ id: 'cs_test_def', url: 'https://checkout.stripe.com/c/pay/cs_test_def' }));
    s.checkout.sessions.expire.mockResolvedValue({});
    const changed = await post(admin, { interval: 'year', seats: 5 });
    expect(s.checkout.sessions.expire).toHaveBeenCalledWith('cs_test_abc');
    expect(changed.body.data.sessionId).toBe('cs_test_def');
  });

  it('expiring an already-paid session syncs it and returns 409 (D6)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await post(admin, { interval: 'month', seats: 5 });
    await createCustomerRow(household.id, { providerCustomerId: 'cus_new' }).catch(() => undefined);
    s.checkout.sessions.expire.mockRejectedValue(new Error('session is complete'));
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_abc', status: 'complete', subscription: 'sub_D6', customer: 'cus_new' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_D6', customer: 'cus_new' }));
    const res = await post(admin, { interval: 'year', seats: 6 });
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_abc' } }))!.status).toBe('complete');
  });

  it('two concurrent requests create exactly one session (D1)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    s.checkout.sessions.create.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return stripeCheckoutSession({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    });
    const [a, b] = await Promise.all([post(admin, { interval: 'month', seats: 5 }), post(admin, { interval: 'month', seats: 5 })]);
    expect(s.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(a.body.data.sessionId).toBe('cs_test_abc');
    expect(b.body.data.sessionId).toBe('cs_test_abc');
  });

  it('recovers a lost customer row by search and survives a unique conflict (D4)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    s.customers.search.mockReturnValue(listOf([{ id: 'cus_found', email: 'a@x' }]));
    await post(admin, { interval: 'month', seats: 5 });
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(s.customers.search).toHaveBeenCalledWith({ query: `metadata['householdId']:'${household.id}' AND metadata['env']:'dev'`, limit: 1 });
    expect((await BillingCustomer.findOne({ where: { householdId: household.id } }))!.providerCustomerId).toBe('cus_found');
  });

  it('a Stripe failure marks the row failed, returns 502, and a retry works', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    s.checkout.sessions.create.mockRejectedValueOnce(new Error('api_connection_error'));
    const fail = await post(admin, { interval: 'month', seats: 5 });
    expect(fail.status).toBe(502);
    expect(fail.body.code).toBe('CHECKOUT_FAILED');
    expect((await BillingCheckoutSession.findOne({ where: { householdId: household.id } }))!.status).toBe('failed');
    expect((await post(admin, { interval: 'month', seats: 5 })).status).toBe(200);
  });

  it('503 BILLING_MODE_UNAVAILABLE without a test key', async () => {
    installStripeMock('test', testBillingConfig({ modes: { test: null, live: null } }));
    const { admin } = await createHouseholdWithAdmin();
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BILLING_MODE_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/copy.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`copy.ts`:
```ts
import type { BillingInterval } from './types';

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Shown in the app next to Subscribe and on the Checkout submit button (§7.4, §9). */
export function autoRenewDisclosure(cents: number, interval: BillingInterval): string {
  return `Renews automatically at ${formatUsd(cents)} per ${interval} until cancelled. Cancel anytime in Manage subscription.`;
}
```

`portal.ts`:
```ts
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import type { BillingMode } from './types';

const configIds = new Map<BillingMode, string | null>();

export function __clearPortalCacheForTests(): void { configIds.clear(); }

/** The configuration created by stripe-bootstrap (plan switching off, cancel at period end). */
export async function getPortalConfigurationId(mode: BillingMode): Promise<string | undefined> {
  if (configIds.has(mode)) return configIds.get(mode) ?? undefined;
  const list = await getStripe(mode).billingPortal.configurations.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 500 });
  const mine = list.find((c) => c.metadata?.rootaroo_portal === 'v1');
  if (!mine) logger.warn(`[Billing] no Rootaroo portal configuration in ${mode} mode; run stripe-bootstrap`);
  configIds.set(mode, mine?.id ?? null);
  return mine?.id;
}

export async function createPortalUrl(mode: BillingMode, customerId: string): Promise<string> {
  const configuration = await getPortalConfigurationId(mode);
  const session = await getStripe(mode).billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getBillingConfig().publicBaseUrl}/api/v1/billing/return/portal`,
    ...(configuration ? { configuration } : {}),
  });
  return session.url;
}
```

`checkout.ts`:
```ts
import Stripe from 'stripe';
import { UniqueConstraintError, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { BillingCheckoutSession, BillingCustomer, BillingSubscription, Household, User } from '../../database/models';
import { AppError, NotFoundError } from '../../shared/utils/errors';
import logger from '../../shared/utils/logger';
import { assertSeats, getCatalog, priceFor } from './catalog';
import { getBillingConfig, getStripe, isModeAvailable } from './config';
import { CallerContext, requireAdminContext } from './context';
import { autoRenewDisclosure } from './copy';
import { BillingConflictError, BillingUnavailableError } from './errors';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { createPortalUrl } from './portal';
import { isStripeCheckoutAllowed, resolvePurchaseMethod } from './routing';
import { idOf, upsertSubscription } from './sync';
import type { BillingInterval, BillingMode, ClientContext } from './types';

export interface CheckoutBody { interval: BillingInterval; seats: number }
export interface CheckoutResult { url: string; sessionId: string }

export const CHECKOUT_SESSION_TTL_SEC = 31 * 60; // Stripe minimum is 30 min; +1 min for clock drift (T7)

export function checkoutLockName(householdId: string, mode: BillingMode): string {
  return `billing:checkout:${householdId}:${mode}`;
}

const envOk = (s: Stripe.Subscription) => !s.metadata?.env || s.metadata.env === getBillingConfig().envTag;

export async function paymentIssueError(mode: BillingMode, customerId: string): Promise<BillingConflictError> {
  let portalUrl: string | null = null;
  try {
    portalUrl = await createPortalUrl(mode, customerId);
  } catch (err) {
    logger.warn(`[Billing] portal URL for PAYMENT_ISSUE failed: ${(err as Error).message}`);
  }
  return new BillingConflictError('PAYMENT_ISSUE', 'Your last payment failed. Update your payment method to continue.', { portalUrl });
}

export async function findOrCreateCustomer(household: Household, mode: BillingMode, admin: User): Promise<string> {
  const livemode = livemodeOf(mode);
  const where = { householdId: household.id, provider: 'stripe' as const, livemode };
  const existing = await BillingCustomer.findOne({ where });
  if (existing) return existing.providerCustomerId;

  const stripe = getStripe(mode);
  const { envTag } = getBillingConfig();
  // Verify at implementation time: https://docs.stripe.com/search.md#query-fields-for-customers (metadata syntax).
  const found = await stripe.customers.search({ query: `metadata['householdId']:'${household.id}' AND metadata['env']:'${envTag}'`, limit: 1 });
  const customer = found.data[0] ?? await stripe.customers.create(
    { email: admin.email, name: household.name, metadata: { householdId: household.id, env: envTag } },
    { idempotencyKey: `cust:${household.id}:${mode}:${admin.id}` },
  );
  try {
    await BillingCustomer.create({ ...where, providerCustomerId: customer.id, billingEmail: customer.email ?? admin.email });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const again = await BillingCustomer.findOne({ where });
    if (again) return again.providerCustomerId;
    throw err;
  }
  return customer.id;
}

async function expireOrSync(row: BillingCheckoutSession, mode: BillingMode): Promise<void> {
  if (!row.providerSessionId) { await row.update({ status: 'failed' }); return; }
  const stripe = getStripe(mode);
  try {
    await stripe.checkout.sessions.expire(row.providerSessionId);
    await row.update({ status: 'expired' });
  } catch (err) {
    const session = await stripe.checkout.sessions.retrieve(row.providerSessionId);
    if (session.status === 'complete') {
      await row.update({ status: 'complete' });
      const subId = idOf(session.subscription as string | { id: string } | null);
      if (subId) await upsertSubscription(subId, mode);
      throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household has just subscribed');
    }
    if (session.status === 'expired') { await row.update({ status: 'expired' }); return; }
    throw err;
  }
}

async function createCheckoutLocked(ctx: CallerContext, body: CheckoutBody, now: Date): Promise<CheckoutResult> {
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  const stripe = getStripe(mode);
  const cfg = getBillingConfig();

  // 4(a) local state
  const local = await BillingSubscription.findAll({
    where: { householdId: household.id, livemode, status: { [Op.in]: ['active', 'trialing', 'past_due', 'unpaid'] } },
  });
  if (local.some((s) => s.status === 'active' || s.status === 'trialing')) {
    throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
  }
  const customerRow = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode } });
  if (customerRow && local.some((s) => s.status === 'past_due' || s.status === 'unpaid')) {
    throw await paymentIssueError(mode, customerRow.providerCustomerId);
  }
  // 4(b) Stripe state
  if (customerRow) {
    const subs = (await stripe.subscriptions.list({ customer: customerRow.providerCustomerId, status: 'all', limit: 10 })).data.filter(envOk);
    const healthy = subs.find((s) => s.status === 'active' || s.status === 'trialing');
    if (healthy) {
      await upsertSubscription(healthy.id, mode);
      throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
    }
    if (subs.some((s) => s.status === 'past_due' || s.status === 'unpaid')) {
      throw await paymentIssueError(mode, customerRow.providerCustomerId);
    }
  }
  // 5. seats
  if (body.seats < ctx.memberCount) {
    throw new BillingConflictError('SEATS_BELOW_MEMBERS', `Your household has ${ctx.memberCount} members. Choose a plan with at least that many.`, { memberCount: ctx.memberCount });
  }
  // 6. reuse or retire the open session
  const open = await BillingCheckoutSession.findOne({ where: { householdId: household.id, livemode, status: 'open' }, order: [['createdAt', 'DESC']] });
  if (open) {
    const reusable = open.url && open.providerSessionId && open.expiresAt && open.expiresAt.getTime() > now.getTime() + 60_000;
    if (reusable && open.interval === body.interval && open.seats === body.seats) return { url: open.url!, sessionId: open.providerSessionId! };
    await expireOrSync(open, mode);
  }
  // 7. customer
  const admin = await User.findByPk(ctx.userId, { paranoid: false });
  if (!admin) throw new NotFoundError('User');
  const customerId = await findOrCreateCustomer(household, mode, admin);
  // 8. session
  const price = priceFor(await getCatalog(mode), body.interval, body.seats);
  const expiresAt = Math.floor(now.getTime() / 1000) + CHECKOUT_SESSION_TTL_SEC;
  const row = await BillingCheckoutSession.create({
    id: uuidv4(), householdId: household.id, livemode, createdByUserId: ctx.userId,
    interval: body.interval, seats: body.seats, status: 'creating', expiresAt: new Date(expiresAt * 1000),
  });
  let session: Stripe.Checkout.Session;
  try {
    // Verify at implementation time against https://docs.stripe.com/api/checkout/sessions/create.md:
    // origin_context, integration_identifier, consent_collection, custom_text.submit for API 2026-09-30.endive.
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: household.id,
      line_items: [{ price: price.priceId, quantity: 1 }],
      subscription_data: { metadata: { householdId: household.id, purchasedByUserId: ctx.userId, env: cfg.envTag } },
      metadata: { householdId: household.id, env: cfg.envTag },
      origin_context: 'mobile_app',
      expires_at: expiresAt,
      allow_promotion_codes: false,
      consent_collection: { terms_of_service: 'required' },
      custom_text: { submit: { message: autoRenewDisclosure(price.amount, body.interval) } },
      success_url: `${cfg.publicBaseUrl}/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cfg.publicBaseUrl}/api/v1/billing/return/cancel`,
      integration_identifier: cfg.integrationId,
    }, { idempotencyKey: `cs:${row.id}` });
  } catch (err) {
    await row.update({ status: 'failed' });
    logger.error(`[Billing] checkout.sessions.create failed for household ${household.id}:`, err);
    throw new AppError(502, 'Could not start checkout. Please try again.', 'CHECKOUT_FAILED');
  }
  // 9.
  await row.update({ status: 'open', providerSessionId: session.id, url: session.url });
  return { url: session.url!, sessionId: session.id };
}

export async function createCheckout(userId: string, body: CheckoutBody, client: ClientContext, now: Date = new Date()): Promise<CheckoutResult> {
  const ctx = await requireAdminContext(userId);
  if (!isModeAvailable(ctx.mode)) throw new BillingUnavailableError();
  const method = await resolvePurchaseMethod(client, ctx.household.billingCohort);
  if (!isStripeCheckoutAllowed(method, ctx.household.billingCohort)) {
    throw new BillingConflictError('PURCHASE_METHOD_MISMATCH', 'Purchases on this device go through a different store', { purchaseMethod: method });
  }
  assertSeats(body.seats);
  return withLock(checkoutLockName(ctx.household.id, ctx.mode), 60_000, () => createCheckoutLocked(ctx, body, now), { waitMs: 10_000 });
}
```
If `tsc` reports `origin_context` or `integration_identifier` missing from `Stripe.Checkout.SessionCreateParams`, the SDK predates them: upgrade within 23.x; do not cast them away.

`controller.ts` add:
```ts
import { createCheckout } from './checkout';
import { parseClientContext } from './routing';

export async function checkout(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await createCheckout(getUserId(req), req.body, parseClientContext(req)) });
  } catch (e) { next(e); }
}
```
`routes.ts` add (with `import { validate } from '../../shared/middleware/validate'; import { checkoutSchema } from './validation';`):
```ts
/**
 * @openapi
 * /billing/checkout:
 *   post:
 *     tags: [Billing]
 *     summary: Start (or reuse) a Stripe Checkout session for the caller's household (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Platform, schema: { type: string, enum: [ios, android, web] } }
 *       - { in: header, name: X-Store-Country, schema: { type: string, example: US } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [interval, seats]
 *             properties:
 *               interval: { type: string, enum: [month, year] }
 *               seats: { type: integer, minimum: 5, maximum: 10 }
 *     responses:
 *       200: { description: "{ url, sessionId }" }
 *       403: { description: Not an admin, or NO_HOUSEHOLD }
 *       409: { description: "ALREADY_SUBSCRIBED | PAYMENT_ISSUE {portalUrl} | SEATS_BELOW_MEMBERS {memberCount} | PURCHASE_METHOD_MISMATCH | LOCK_BUSY" }
 *       502: { description: CHECKOUT_FAILED }
 *       503: { description: BILLING_MODE_UNAVAILABLE }
 */
router.post('/checkout', validate(checkoutSchema), ctrl.checkout);
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/copy.test.ts && npm run test:int -- src/modules/billing/__int__/checkout.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): POST /billing/checkout with lock, stale-state checks and session reuse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.6: Return page, checkout sync and `GET /billing/status` (§8.2, §7.4)

**Files:**
- Create: `server/src/modules/billing/returnPage.ts`
- Modify: `server/src/modules/billing/checkout.ts`, `controller.ts`, `routes.ts`
- Test: `server/src/modules/billing/__tests__/returnPage.test.ts`, `server/src/modules/billing/__int__/syncStatus.int.test.ts`

**Interfaces:**
- Produces:
  - `buildReturnTarget(result: string, sessionId: unknown): string | null`, `returnPageHtml(target: string | null): string`, handler `billingReturn`
  - `deriveCheckoutState(sessionStatus: string | null, allowed: boolean): CheckoutState`
  - `interface SyncResult { entitlement: Entitlement; pendingCheckout: PendingCheckout }`; `syncCheckout(userId: string, sessionId: string): Promise<SyncResult>`
  - `interface SubscriptionView { provider; status; interval; seats; unitAmount: number | null; currency: string | null; priceSet: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; pendingUpdate: boolean }`
  - `interface BillingStatus { entitlement: Entitlement; subscription: SubscriptionView | null; isAdmin: boolean; adminNames: string[]; purchaseMethod: PurchaseMethod; plans: PlansResponse | null; pendingCheckout: PendingCheckout | null; memberCount: number }`
  - `getBillingStatus(userId: string, client: ClientContext): Promise<BillingStatus>`
  - Routes: `GET /api/v1/billing/return/:result` (public), `POST /api/v1/billing/checkout/:sessionId/sync`, `GET /api/v1/billing/status`

`memberCount` is an addition to the §7.4 status shape: the Subscription screen shows "seats used/allowed" and the paywall stepper's minimum is the member count.

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/returnPage.test.ts`:
```ts
import { buildReturnTarget, returnPageHtml } from '../returnPage';
import { deriveCheckoutState } from '../checkout';

describe('return route (§8.2, B1)', () => {
  it.each([
    ['success', 'cs_test_a1B2', 'rootaroo://billing/success?session_id=cs_test_a1B2'],
    ['cancel', undefined, 'rootaroo://billing/cancel'],
    ['portal', undefined, 'rootaroo://billing/portal'],
  ])('%s -> deep link', (result, sid, target) => expect(buildReturnTarget(result, sid)).toBe(target));

  it.each([
    ['refund', undefined], ['success', 'cs_test_<script>'], ['success', 'pi_123'], ['success', ['cs_test_a', 'cs_test_b']], ['SUCCESS', undefined],
  ])('rejects %s / %p', (result, sid) => expect(buildReturnTarget(result as string, sid)).toBeNull());

  it('renders a static page with a plain link and no script', () => {
    const html = returnPageHtml('rootaroo://billing/success?session_id=cs_test_1');
    expect(html).toContain('href="rootaroo://billing/success?session_id=cs_test_1"');
    expect(html).toContain('Return to Rootaroo');
    expect(html).not.toMatch(/<script/i);
    expect(returnPageHtml(null)).not.toContain('href=');
  });
});

describe('deriveCheckoutState', () => {
  it('maps session status and entitlement', () => {
    expect(deriveCheckoutState('open', false)).toBe('open');
    expect(deriveCheckoutState('complete', false)).toBe('processing');
    expect(deriveCheckoutState('complete', true)).toBe('complete');
    expect(deriveCheckoutState('expired', false)).toBe('expired');
  });
});
```

`server/src/modules/billing/__int__/syncStatus.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingCheckoutSession } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { seedDefaultRoutingRules } from '../routing';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  await seedDefaultRoutingRules('development');
  clearLocalCatalogCache();
  s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
});
afterAll(() => closeIntResources());

async function paidHousehold() {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
  await BillingCheckoutSession.create({ id: '11111111-1111-4111-8111-111111111111', householdId: household.id, livemode: false, providerSessionId: 'cs_test_ok', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open', url: 'u', expiresAt: new Date(Date.now() + 1e6) });
  return { household, admin };
}

describe('GET /billing/return/:result', () => {
  it('302s to the app with no auth and no side effects', async () => {
    const res = await request(app).get('/api/v1/billing/return/success?session_id=cs_test_ok');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('rootaroo://billing/success?session_id=cs_test_ok');
    expect(s.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('serves a static page for anything else', async () => {
    const res = await request(app).get('/api/v1/billing/return/success?session_id=evil');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Return to Rootaroo');
  });
});

describe('POST /billing/checkout/:id/sync', () => {
  it('syncs a completed session and unlocks; any member may sync (T3)', async () => {
    const { household } = await paidHousehold();
    const member = await addMember(household.id);
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_1', subscription: 'sub_1' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(member));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ entitlement: { allowed: true }, pendingCheckout: { sessionId: 'cs_test_ok', state: 'complete' } });
    expect(s.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_ok', { expand: ['subscription'] });
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_ok' } }))!.status).toBe('complete');
  });

  it('reports processing while the subscription is not yet active (T4)', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_1', subscription: 'sub_1' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'incomplete' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin));
    expect(res.body.data).toMatchObject({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } });
  });

  it("403 for another household's session (B2)", async () => {
    const { admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: 'someone-else', customer: 'cus_1' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('403 when the customer does not match (B2)', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_other' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('403 for a live session id in a test-mode household without calling Stripe (B3)', async () => {
    const { admin } = await paidHousehold();
    expect((await request(app).post('/api/v1/billing/checkout/cs_live_abc/sync').set(authHeaderFor(admin))).status).toBe(403);
    expect(s.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('403 when Stripe does not know the session', async () => {
    const { admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockRejectedValue(Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', code: 'resource_missing' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_zzz/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('marks expired sessions', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'expired', clientReferenceId: household.id, customer: 'cus_1' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin));
    expect(res.body.data.pendingCheckout.state).toBe('expired');
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_ok' } }))!.status).toBe('expired');
  });
});

describe('GET /billing/status', () => {
  it('returns the full status shape', async () => {
    const { household, admin } = await paidHousehold();
    await addMember(household.id);
    const res = await request(app).get('/api/v1/billing/status').set(authHeaderFor(admin)).set('X-Platform', 'android').set('X-Store-Country', 'us');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      entitlement: { allowed: false, reason: 'subscription_required' }, subscription: null, isAdmin: true,
      adminNames: [admin.displayName], purchaseMethod: 'stripe_checkout', memberCount: 2,
      pendingCheckout: { sessionId: 'cs_test_ok', state: 'open' }, plans: { seatsIncluded: 5 },
    });
  });

  it('still answers when the catalog is unavailable (plans: null)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    s.prices.list.mockReturnValue(listOf([]));
    const res = await request(app).get('/api/v1/billing/status').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.plans).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/returnPage.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`returnPage.ts`:
```ts
import { Request, Response } from 'express';

const RESULTS = new Set(['success', 'cancel', 'portal']);
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;

export function buildReturnTarget(result: string, sessionId: unknown): string | null {
  if (!RESULTS.has(result)) return null;
  if (sessionId === undefined) return `rootaroo://billing/${result}`;
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  return `rootaroo://billing/${result}?session_id=${sessionId}`;
}

/** Static fallback: plain link, no script, so helmet's default CSP is satisfied. */
export function returnPageHtml(target: string | null): string {
  const link = target ? `<p><a href="${target}" style="font-size:20px">Return to Rootaroo</a></p>` : '<p>Return to Rootaroo to continue.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rootaroo</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px">${link}<p>You can close this page.</p></body></html>`;
}

/** Public, side-effect free, grants nothing (§8.2, B1). */
export function billingReturn(req: Request, res: Response): void {
  const target = buildReturnTarget(req.params.result, req.query.session_id);
  if (!target) {
    res.status(200).type('html').send(returnPageHtml(null));
    return;
  }
  res.status(302).location(target).type('html').send(returnPageHtml(target));
}
```

Append to `checkout.ts` (add imports: `HouseholdMember` to the models import, `ForbiddenError` from shared errors, `getEntitlement` from `./entitlement`, `loadCallerContext` from `./context`, `getPlansForMode, PlansResponse` from `./plans`, types `Entitlement, PendingCheckout, CheckoutState, PurchaseMethod`):
```ts
export function deriveCheckoutState(sessionStatus: string | null, allowed: boolean): CheckoutState {
  if (sessionStatus === 'complete') return allowed ? 'complete' : 'processing';
  if (sessionStatus === 'expired') return 'expired';
  return 'open';
}

export interface SyncResult { entitlement: Entitlement; pendingCheckout: PendingCheckout }

export async function syncCheckout(userId: string, sessionId: string): Promise<SyncResult> {
  const ctx = await loadCallerContext(userId);
  const { household, mode } = ctx;
  const denied = () => new ForbiddenError('This checkout session does not belong to your household');
  if (sessionId.startsWith('cs_live_') !== (mode === 'live')) throw denied();
  const stripe = getStripe(mode);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') throw denied();
    throw err;
  }
  const customer = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode: livemodeOf(mode) } });
  if (session.client_reference_id !== household.id || !customer || idOf(session.customer as string | { id: string } | null) !== customer.providerCustomerId) {
    throw denied();
  }
  const row = await BillingCheckoutSession.findOne({ where: { providerSessionId: sessionId } });
  if (session.status === 'complete') {
    if (row && row.status !== 'complete') await row.update({ status: 'complete' });
    const subId = idOf(session.subscription as string | { id: string } | null);
    if (subId) await upsertSubscription(subId, mode);
  } else if (session.status === 'expired' && row) {
    await row.update({ status: 'expired' });
  }
  const entitlement = await getEntitlement(household.id, { bypassCache: true });
  return { entitlement, pendingCheckout: { sessionId, state: deriveCheckoutState(session.status, entitlement.allowed) } };
}

export interface SubscriptionView {
  provider: string; status: string; interval: string; seats: number; unitAmount: number | null; currency: string | null;
  priceSet: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; pendingUpdate: boolean;
}

export interface BillingStatus {
  entitlement: Entitlement;
  subscription: SubscriptionView | null;
  isAdmin: boolean;
  adminNames: string[];
  purchaseMethod: PurchaseMethod;
  plans: PlansResponse | null;
  pendingCheckout: PendingCheckout | null;
  memberCount: number;
}

export async function getBillingStatus(userId: string, client: ClientContext): Promise<BillingStatus> {
  const ctx = await loadCallerContext(userId);
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  const entitlement = await getEntitlement(household.id);
  const sub = await BillingSubscription.findOne({ where: { householdId: household.id, livemode }, order: [['updatedAt', 'DESC']] });
  const admins = await HouseholdMember.findAll({ where: { householdId: household.id, role: 'admin' }, include: [{ model: User, as: 'user', required: true }] });
  let plans: PlansResponse | null = null;
  try { plans = await getPlansForMode(mode); } catch (err) { logger.warn(`[Billing] plans unavailable: ${(err as Error).message}`); }

  const recent = await BillingCheckoutSession.findOne({
    where: { householdId: household.id, livemode, status: { [Op.in]: ['open', 'complete'] }, createdAt: { [Op.gte]: new Date(Date.now() - 2 * 3600_000) } },
    order: [['createdAt', 'DESC']],
  });
  let pendingCheckout: PendingCheckout | null = null;
  if (recent?.providerSessionId) {
    if (recent.status === 'open' && recent.expiresAt && recent.expiresAt.getTime() > Date.now()) pendingCheckout = { sessionId: recent.providerSessionId, state: 'open' };
    else if (recent.status === 'complete' && !entitlement.allowed) pendingCheckout = { sessionId: recent.providerSessionId, state: 'processing' };
  }

  return {
    entitlement,
    subscription: sub ? {
      provider: sub.provider, status: sub.status, interval: sub.interval, seats: sub.seats, unitAmount: sub.unitAmount, currency: sub.currency,
      priceSet: sub.priceSet, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceUntil: sub.graceUntil?.toISOString() ?? null, pendingUpdate: sub.pendingUpdate !== null,
    } : null,
    isAdmin: ctx.isAdmin,
    adminNames: admins.map((a) => a.user!.displayName),
    purchaseMethod: await resolvePurchaseMethod(client, household.billingCohort),
    plans,
    pendingCheckout,
    memberCount: ctx.memberCount,
  };
}
```

`controller.ts` add:
```ts
import { getBillingStatus, syncCheckout } from './checkout';

export async function sync(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await syncCheckout(getUserId(req), req.params.sessionId) });
  } catch (e) { next(e); }
}

export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await getBillingStatus(getUserId(req), parseClientContext(req)) });
  } catch (e) { next(e); }
}
```

`routes.ts`: in the public section, before `router.use(authenticate)`:
```ts
/**
 * @openapi
 * /billing/return/{result}:
 *   get:
 *     tags: [Billing]
 *     summary: Public Checkout/portal return page. 302 to rootaroo://billing/<result>; no side effects
 *     parameters:
 *       - { in: path, name: result, required: true, schema: { type: string, enum: [success, cancel, portal] } }
 *       - { in: query, name: session_id, schema: { type: string, pattern: '^cs_(test|live)_[A-Za-z0-9]+$' } }
 *     responses:
 *       302: { description: Redirect into the app }
 *       200: { description: Static fallback page }
 */
router.get('/return/:result', billingReturn);
```
After `router.use(authenticate)` (import `syncParamsSchema`):
```ts
/**
 * @openapi
 * /billing/checkout/{sessionId}/sync:
 *   post:
 *     tags: [Billing]
 *     summary: Sync a Checkout session for the caller's household (any member)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: sessionId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ entitlement, pendingCheckout: { sessionId, state: open|processing|complete|expired } }" }
 *       403: { description: Session belongs to another household or mode }
 * /billing/status:
 *   get:
 *     tags: [Billing]
 *     summary: Entitlement, subscription, admins, purchase method, plans and pending checkout
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ entitlement, subscription, isAdmin, adminNames, purchaseMethod, plans, pendingCheckout, memberCount }" }
 *       403: { description: NO_HOUSEHOLD }
 */
router.post('/checkout/:sessionId/sync', validate(syncParamsSchema), ctrl.sync);
router.get('/status', ctrl.status);
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/returnPage.test.ts && npm run test:int -- src/modules/billing/__int__/syncStatus.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): public return page, checkout sync with ownership checks, GET /billing/status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 5.7: Portal and plan changes (§8.3, §6.5)

**Files:**
- Create: `server/src/modules/billing/plan.ts`
- Modify: `server/src/modules/billing/portal.ts`, `controller.ts`, `routes.ts`
- Test: `server/src/modules/billing/__int__/planPortal.int.test.ts`

**Interfaces:**
- Consumes: `paymentIssueError`, `checkoutLockName` (5.5); `findPriceInSet`, `getCatalog`, `priceFor` (3.1); `upsertSubscription` (5.3).
- Produces:
  - `openPortal(userId: string): Promise<{ url: string }>` (admin; `409 NO_ACTIVE_SUBSCRIPTION` without a customer)
  - `choosePlanPrice(mode: BillingMode, sub: BillingSubscription, interval: BillingInterval, seats: number): Promise<CatalogPrice>` (scheduled notice's `to` set → current `price_set` if active → current lookup key)
  - `interface PlanChangeResult { changed: boolean; pendingUpdate: boolean; hostedInvoiceUrl: string | null; entitlement: Entitlement }`
  - `changePlan(userId: string, body: { interval: BillingInterval; seats: number }): Promise<PlanChangeResult>`
  - Routes `POST /api/v1/billing/portal`, `POST /api/v1/billing/plan`

- [ ] **Step 1: Write the failing integration test**

`server/src/modules/billing/__int__/planPortal.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingPriceNotice } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripePrice, stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { __clearPortalCacheForTests } from '../portal';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  __clearPortalCacheForTests();
  s = installStripeMock('test');
  const old6m = stripePrice({ id: 'price_old_6m', seats: 6, interval: 'month', priceSet: '2025-01', amount: 999, lookupKey: null });
  const all = [...catalogPrices(), old6m, ...catalogPrices('2027-01').map((p) => ({ ...p, lookup_key: null }))];
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
  s.billingPortal.configurations.list.mockReturnValue(listOf([{ id: 'bpc_1', metadata: { rootaroo_portal: 'v1' } }]));
  s.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
});
afterAll(() => closeIntResources());

async function subscribed(overrides: Record<string, unknown> = {}) {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
  const row = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_1', ...overrides });
  s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1', itemId: 'si_1', seats: row.seats, interval: row.interval }));
  s.subscriptions.update.mockImplementation(async () => stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));
  return { household, admin, row };
}
const plan = (user: any, body: unknown) => request(app).post('/api/v1/billing/plan').set(authHeaderFor(user)).send(body);

describe('POST /billing/portal', () => {
  it('opens the tagged portal configuration for an admin', async () => {
    const { admin } = await subscribed();
    const res = await request(app).post('/api/v1/billing/portal').set(authHeaderFor(admin));
    expect(res.body.data.url).toBe('https://billing.stripe.com/p/session/x');
    expect(s.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://api.example.test/api/v1/billing/return/portal', configuration: 'bpc_1' });
  });

  it('403 for members, 409 without a customer', async () => {
    const { household } = await subscribed();
    expect((await request(app).post('/api/v1/billing/portal').set(authHeaderFor(await addMember(household.id)))).status).toBe(403);
    const other = await createHouseholdWithAdmin();
    expect((await request(app).post('/api/v1/billing/portal').set(authHeaderFor(other.admin))).body.code).toBe('NO_ACTIVE_SUBSCRIPTION');
  });
});

describe('POST /billing/plan', () => {
  it('same interval: swaps the item price with always_invoice + pending_if_incomplete', async () => {
    const { admin } = await subscribed();
    const res = await plan(admin, { interval: 'month', seats: 7 });
    expect(res.status).toBe(200);
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_1', price: 'price_202610_7_month' }], payment_behavior: 'pending_if_incomplete',
      proration_behavior: 'always_invoice', expand: ['latest_invoice'],
    });
  });

  it('interval change: create_prorations and billing_cycle_anchor now', async () => {
    const { admin } = await subscribed();
    await plan(admin, { interval: 'year', seats: 5 });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      items: [{ id: 'si_1', price: 'price_202610_5_year' }], proration_behavior: 'create_prorations', billing_cycle_anchor: 'now', payment_behavior: 'pending_if_incomplete',
    }));
  });

  it('no change -> 200 without calling Stripe', async () => {
    const { admin } = await subscribed();
    const res = await plan(admin, { interval: 'month', seats: 5 });
    expect(res.body.data.changed).toBe(false);
    expect(s.subscriptions.update).not.toHaveBeenCalled();
  });

  it('409 SEATS_BELOW_MEMBERS (L5)', async () => {
    const { household, admin } = await subscribed({ seats: 7 });
    for (let i = 0; i < 6; i++) await addMember(household.id);
    expect((await plan(admin, { interval: 'month', seats: 6 })).body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 7 });
  });

  it('grandfathered subscribers stay on their price set (§6.5)', async () => {
    const { admin } = await subscribed({ priceSet: '2025-01', seats: 5 });
    await plan(admin, { interval: 'month', seats: 6 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_old_6m');
  });

  it('falls back to the current lookup key when the old set lacks that size', async () => {
    const { admin } = await subscribed({ priceSet: '2025-01', seats: 5 });
    await plan(admin, { interval: 'month', seats: 8 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_202610_8_month');
  });

  it('a scheduled price notice re-targets the to-set (§6.4)', async () => {
    const { admin, row } = await subscribed();
    await BillingPriceNotice.create({ subscriptionId: row.id, fromPriceId: 'price_202610_5_month', toPriceSet: '2027-01', noticeSentAt: new Date(), applyAfter: new Date(Date.now() + 30 * 86400_000) });
    await plan(admin, { interval: 'month', seats: 6 });
    expect(s.subscriptions.update.mock.calls[0][1].items[0].price).toBe('price_202701_6_month');
  });

  it('a failed upgrade returns pendingUpdate and the hosted invoice (T8)', async () => {
    const { admin } = await subscribed();
    s.subscriptions.update.mockResolvedValue(stripeSubscription({
      id: 'sub_1', customer: 'cus_1', pendingUpdate: { expires_at: 1 }, latestInvoice: stripeInvoice({ status: 'open', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' }),
    }));
    const res = await plan(admin, { interval: 'month', seats: 9 });
    expect(res.body.data).toMatchObject({ changed: true, pendingUpdate: true, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
  });

  it('403 for non-admins (B6), 409 for store subscriptions and past_due', async () => {
    const { household } = await subscribed();
    expect((await plan(await addMember(household.id), { interval: 'month', seats: 6 })).status).toBe(403);
    const store = await createHouseholdWithAdmin();
    await createSubscriptionRow(store.household.id, { provider: 'apple', providerSubscriptionId: '2000000999' });
    expect((await plan(store.admin, { interval: 'month', seats: 6 })).body.code).toBe('PURCHASE_METHOD_MISMATCH');
    const pd = await createHouseholdWithAdmin();
    await createCustomerRow(pd.household.id, { providerCustomerId: 'cus_pd' });
    await createSubscriptionRow(pd.household.id, { status: 'past_due', graceUntil: new Date(Date.now() + 1e6) });
    expect((await plan(pd.admin, { interval: 'month', seats: 6 })).body.code).toBe('PAYMENT_ISSUE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/planPortal.int.test.ts` → FAIL (404 routes).

- [ ] **Step 3: Implement**

Append to `portal.ts`:
```ts
import { BillingCustomer } from '../../database/models';
import { requireAdminContext } from './context';
import { BillingConflictError } from './errors';
import { livemodeOf } from './mode';

export async function openPortal(userId: string): Promise<{ url: string }> {
  const ctx = await requireAdminContext(userId);
  const customer = await BillingCustomer.findOne({ where: { householdId: ctx.household.id, provider: 'stripe', livemode: livemodeOf(ctx.mode) } });
  if (!customer) throw new BillingConflictError('NO_ACTIVE_SUBSCRIPTION', 'There is no billing account for this household yet');
  return { url: await createPortalUrl(ctx.mode, customer.providerCustomerId) };
}
```

`plan.ts`:
```ts
import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingCustomer, BillingPriceNotice, BillingSubscription } from '../../database/models';
import { assertSeats, CatalogPrice, findPriceInSet, getCatalog, priceFor } from './catalog';
import { checkoutLockName, paymentIssueError } from './checkout';
import { getStripe } from './config';
import { requireAdminContext } from './context';
import { getEntitlement } from './entitlement';
import { BillingConflictError } from './errors';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { upsertSubscription } from './sync';
import type { BillingInterval, BillingMode, Entitlement } from './types';

export interface PlanChangeResult { changed: boolean; pendingUpdate: boolean; hostedInvoiceUrl: string | null; entitlement: Entitlement }

export async function choosePlanPrice(mode: BillingMode, sub: BillingSubscription, interval: BillingInterval, seats: number): Promise<CatalogPrice> {
  const notice = await BillingPriceNotice.findOne({ where: { subscriptionId: sub.id, status: 'scheduled' } });
  if (notice) {
    const p = await findPriceInSet(mode, notice.toPriceSet, interval, seats);
    if (p) return p;
  }
  if (sub.priceSet) {
    const p = await findPriceInSet(mode, sub.priceSet, interval, seats);
    if (p) return p;
  }
  return priceFor(await getCatalog(mode), interval, seats);
}

export async function changePlan(userId: string, body: { interval: BillingInterval; seats: number }): Promise<PlanChangeResult> {
  const ctx = await requireAdminContext(userId);
  assertSeats(body.seats);
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  return withLock(checkoutLockName(household.id, mode), 60_000, async () => {
    const sub = await BillingSubscription.findOne({
      where: { householdId: household.id, livemode, status: { [Op.in]: ['active', 'trialing', 'past_due'] } }, order: [['createdAt', 'DESC']],
    });
    if (!sub) throw new BillingConflictError('NO_ACTIVE_SUBSCRIPTION', 'There is no active subscription to change');
    if (sub.provider !== 'stripe') {
      throw new BillingConflictError('PURCHASE_METHOD_MISMATCH', 'Change your plan in the store where you subscribed', { provider: sub.provider });
    }
    if (sub.status === 'past_due') {
      const customer = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode } });
      throw await paymentIssueError(mode, customer!.providerCustomerId);
    }
    if (body.seats < ctx.memberCount) {
      throw new BillingConflictError('SEATS_BELOW_MEMBERS', `Your household has ${ctx.memberCount} members`, { memberCount: ctx.memberCount });
    }
    if (body.seats === sub.seats && body.interval === sub.interval) {
      return { changed: false, pendingUpdate: sub.pendingUpdate !== null, hostedInvoiceUrl: null, entitlement: await getEntitlement(household.id) };
    }

    const price = await choosePlanPrice(mode, sub, body.interval, body.seats);
    const stripe = getStripe(mode);
    const current = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
    const intervalChange = body.interval !== sub.interval;
    // Verify at implementation time: billing_cycle_anchor is allowed with pending_if_incomplete
    // (https://docs.stripe.com/billing/subscriptions/pending-updates-reference.md).
    const updated = await stripe.subscriptions.update(sub.providerSubscriptionId, {
      items: [{ id: current.items.data[0].id, price: price.priceId }],
      payment_behavior: 'pending_if_incomplete',
      proration_behavior: intervalChange ? 'create_prorations' : 'always_invoice',
      ...(intervalChange ? { billing_cycle_anchor: 'now' as const } : {}),
      expand: ['latest_invoice'],
    });
    await upsertSubscription(sub.providerSubscriptionId, mode);
    const invoice = typeof updated.latest_invoice === 'object' ? (updated.latest_invoice as Stripe.Invoice | null) : null;
    const pending = updated.pending_update !== null && updated.pending_update !== undefined;
    return {
      changed: true,
      pendingUpdate: pending,
      hostedInvoiceUrl: pending && invoice?.status === 'open' ? invoice.hosted_invoice_url ?? null : null,
      entitlement: await getEntitlement(household.id, { bypassCache: true }),
    };
  }, { waitMs: 10_000 });
}
```

`controller.ts` add:
```ts
import { openPortal } from './portal';
import { changePlan } from './plan';

export async function portal(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await openPortal(getUserId(req)) }); } catch (e) { next(e); }
}

export async function plan(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await changePlan(getUserId(req), req.body) }); } catch (e) { next(e); }
}
```
`routes.ts` add (import `planChangeSchema`):
```ts
/**
 * @openapi
 * /billing/portal:
 *   post:
 *     tags: [Billing]
 *     summary: Open the Stripe customer portal (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ url }" }
 *       409: { description: NO_ACTIVE_SUBSCRIPTION }
 * /billing/plan:
 *   post:
 *     tags: [Billing]
 *     summary: Change household size and/or interval (admin only, Stripe subscriptions only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [interval, seats]
 *             properties:
 *               interval: { type: string, enum: [month, year] }
 *               seats: { type: integer, minimum: 5, maximum: 10 }
 *     responses:
 *       200: { description: "{ changed, pendingUpdate, hostedInvoiceUrl, entitlement }" }
 *       409: { description: "SEATS_BELOW_MEMBERS | NO_ACTIVE_SUBSCRIPTION | PURCHASE_METHOD_MISMATCH | PAYMENT_ISSUE" }
 */
router.post('/portal', ctrl.portal);
router.post('/plan', validate(planChangeSchema), ctrl.plan);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/planPortal.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): customer portal and plan changes with pending updates and grandfathering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 5 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
```
Plus a manual smoke against the dev sandbox (orchestrator, server on `npm run dev`, dev admin token in `$TOKEN`):
```bash
curl -s -X POST localhost:3000/api/v1/billing/checkout -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'X-Platform: android' -d '{"interval":"month","seats":5}'
```
Acceptance:
- All green versus baseline.
- The smoke returns a real `https://checkout.stripe.com/...` URL; opening it in Chrome shows $8.99/month, the auto-renewal text on the submit button and the Terms checkbox. Calling it twice returns the same `sessionId`. Record in `docs/superpowers/evidence/w5-checkout.md` (no keys).
- `GET /api/v1/billing/status` returns `pendingCheckout.state = "open"` afterwards.

---
## Wave 6: Ledger, event handling, webhook receiver, deletion hooks (§8.4–8.7, §5.11)

### Task 6.1: Ledger (§5.6, §8.4 ledger linking)

**Files:**
- Create: `server/src/modules/billing/ledger.ts`
- Test: `server/src/modules/billing/__tests__/ledger.test.ts`, `server/src/modules/billing/__int__/ledger.int.test.ts`

**Interfaces:**
- Consumes: `idOf` (5.3), `raiseReviewItem` (5.1), `getStripe` (2.3).
- Produces:
  - `ANONYMIZED_EMAIL = 'deleted user'`
  - `interface LedgerLink { householdId: string | null; userId: string | null; subscriptionId: string | null; matchStatus: 'matched' | 'unmatched'; householdNameSnapshot: string | null; payerEmailSnapshot: string | null }`
  - `invoiceSubscriptionId(inv: Stripe.Invoice): string | null` (`inv.parent.subscription_details.subscription`)
  - `linkInvoice(inv: Stripe.Invoice, mode: BillingMode): Promise<LedgerLink>`
  - `fetchPaymentFees(invoiceId: string, mode: BillingMode): Promise<{ fee: number | null; net: number | null; chargeId: string; receiptUrl: string | null } | null>`
  - `mergeLedgerFields(existing: BillingTransaction | null, fields: LedgerFields): LedgerFields` (pure)
  - `upsertLedgerRow(identity: { provider: 'stripe'|'apple'|'google'; livemode: boolean; type: LedgerType; providerObjectId: string }, fields: LedgerFields): Promise<BillingTransaction>`
  - `recordInvoice(inv: Stripe.Invoice, mode, type: 'payment' | 'failed_payment', eventId: string | null): Promise<BillingTransaction>`
  - `resolvePaymentLink(paymentIntentId: string | null, chargeId: string | null, mode): Promise<LedgerLink & { invoiceId: string | null }>`
  - `recordRefund(refund: Stripe.Refund, mode, eventId: string | null): Promise<BillingTransaction>`
  - `disputeFunds(d: Stripe.Dispute): { fundsState: FundsState; disputeFee: number }` (pure)
  - `recordDispute(d: Stripe.Dispute, mode, eventId: string | null): Promise<BillingTransaction>`
  - `anonymizeUserLedger(userId: string): Promise<number>`
  - `type LedgerFields = Partial<Omit<BillingTransaction attributes, 'id'|'provider'|'livemode'|'type'|'providerObjectId'|'createdAt'|'updatedAt'>>`

- [ ] **Step 1: Write the failing unit test**

`server/src/modules/billing/__tests__/ledger.test.ts`:
```ts
import { disputeFunds, mergeLedgerFields, invoiceSubscriptionId, ANONYMIZED_EMAIL } from '../ledger';
import { stripeDispute, stripeInvoice } from '../../../test/billing/fixtures';

describe('ledger helpers', () => {
  it('reads the subscription from invoice.parent (pinned API shape)', () => {
    expect(invoiceSubscriptionId(stripeInvoice({ subscriptionId: 'sub_9' }))).toBe('sub_9');
    expect(invoiceSubscriptionId(stripeInvoice({ subscriptionId: null }))).toBeNull();
  });

  it('derives dispute funds state and fee (L4)', () => {
    expect(disputeFunds(stripeDispute())).toEqual({ fundsState: 'none', disputeFee: 0 });
    expect(disputeFunds(stripeDispute({ balanceTransactions: [{ amount: -899, fee: 1500 }] }))).toEqual({ fundsState: 'withdrawn', disputeFee: 1500 });
    expect(disputeFunds(stripeDispute({ balanceTransactions: [{ amount: -899, fee: 1500 }, { amount: 899, fee: -1500 }] }))).toEqual({ fundsState: 'reinstated', disputeFee: 0 });
  });

  it('never replaces known fees with null and keeps anonymisation', () => {
    const existing: any = { fee: 56, net: 843, providerChargeId: 'ch_1', receiptUrl: 'r', disputeFee: null, payerEmailSnapshot: ANONYMIZED_EMAIL, userId: null, matchStatus: 'matched', householdId: 'h1', subscriptionId: 's1', householdNameSnapshot: 'Fam' };
    const merged = mergeLedgerFields(existing, { fee: null, net: null, providerChargeId: null, userId: 'u1', payerEmailSnapshot: 'a@x', amount: 899 });
    expect(merged).toMatchObject({ fee: 56, net: 843, providerChargeId: 'ch_1', userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL, amount: 899 });
  });

  it('does not downgrade a matched row to unmatched', () => {
    const existing: any = { matchStatus: 'matched', householdId: 'h1', userId: 'u1', subscriptionId: 's1', householdNameSnapshot: 'Fam', payerEmailSnapshot: 'a@x' };
    expect(mergeLedgerFields(existing, { matchStatus: 'unmatched', householdId: null, userId: null, subscriptionId: null })).toMatchObject({ matchStatus: 'matched', householdId: 'h1', subscriptionId: 's1' });
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`server/src/modules/billing/__int__/ledger.int.test.ts`:
```ts
import { setupAssociations, BillingTransaction, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { stripeInvoice, stripeRefund, stripeDispute } from '../../../test/billing/fixtures';
import { recordInvoice, recordRefund, recordDispute, anonymizeUserLedger, ANONYMIZED_EMAIL } from '../ledger';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function linked() {
  const { household, admin } = await createHouseholdWithAdmin({ name: 'Rai Family' });
  await createCustomerRow(household.id, { providerCustomerId: 'cus_L' });
  const sub = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_L', purchasedByUserId: admin.id });
  s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_L', latest_charge: 'ch_L' } }, invoice: stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }) }]));
  s.charges.retrieve.mockResolvedValue({ id: 'ch_L', customer: 'cus_L', receipt_url: 'https://pay.stripe.com/receipts/x', balance_transaction: { fee: 56, net: 843 } });
  return { household, admin, sub };
}

describe('ledger', () => {
  it('records a linked payment with fee and net (criterion 4)', async () => {
    const { household, admin, sub } = await linked();
    const row = await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L', billingReason: 'subscription_cycle', amountPaid: 899 }), 'test', 'payment', 'evt_1');
    expect(row).toMatchObject({
      type: 'payment', status: 'paid', amount: 899, fee: 56, net: 843, householdId: household.id, userId: admin.id, subscriptionId: sub.id,
      matchStatus: 'matched', householdNameSnapshot: 'Rai Family', providerChargeId: 'ch_L', billingReason: 'subscription_cycle', lastEventId: 'evt_1',
    });
    // Verify at implementation time: https://docs.stripe.com/api/invoice-payment/list.md and https://docs.stripe.com/expand.md (≤ 4 levels).
    expect(s.invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_L', limit: 10, expand: ['data.payment.payment_intent'] });
    expect(s.charges.retrieve).toHaveBeenCalledWith('ch_L', { expand: ['balance_transaction'] });
  });

  it('keeps fee NULL when unavailable, for reconciliation to fill', async () => {
    await linked();
    s.charges.retrieve.mockResolvedValue({ id: 'ch_L', balance_transaction: null, receipt_url: null });
    expect((await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null)).fee).toBeNull();
  });

  it('one failed_payment row per invoice, updated in place', async () => {
    await linked();
    await recordInvoice(stripeInvoice({ id: 'in_F', customer: 'cus_L', subscriptionId: 'sub_L', status: 'open', amountDue: 899 }), 'test', 'failed_payment', 'evt_a');
    await recordInvoice(stripeInvoice({ id: 'in_F', customer: 'cus_L', subscriptionId: 'sub_L', status: 'open', amountDue: 899 }), 'test', 'failed_payment', 'evt_b');
    const rows = await BillingTransaction.findAll({ where: { providerObjectId: 'in_F' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'failed_payment', status: 'failed', lastEventId: 'evt_b' });
  });

  it('falls back to the customer, then unmatched + review', async () => {
    const { household } = await linked();
    expect((await recordInvoice(stripeInvoice({ id: 'in_C', customer: 'cus_L', subscriptionId: null }), 'test', 'payment', null)).householdId).toBe(household.id);
    const orphan = await recordInvoice(stripeInvoice({ id: 'in_O', customer: 'cus_none', subscriptionId: 'sub_none' }), 'test', 'payment', null);
    expect(orphan.matchStatus).toBe('unmatched');
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_invoice', providerObjectId: 'in_O' } })).toBe(1);
  });

  it('records refunds per refund object, keeping status current (L3)', async () => {
    const { household } = await linked();
    await recordRefund(stripeRefund({ id: 're_1', amount: 400, status: 'pending', paymentIntent: 'pi_L', charge: 'ch_L' }), 'test', 'evt_r1');
    const row = await recordRefund(stripeRefund({ id: 're_1', amount: 400, status: 'succeeded', paymentIntent: 'pi_L', charge: 'ch_L' }), 'test', 'evt_r2');
    expect(row).toMatchObject({ type: 'refund', amount: 400, status: 'succeeded', householdId: household.id, providerInvoiceId: 'in_L' });
    expect(await BillingTransaction.count({ where: { type: 'refund' } })).toBe(1);
  });

  it('records disputes with funds state and fee', async () => {
    const { household } = await linked();
    const row = await recordDispute(stripeDispute({ id: 'dp_1', paymentIntent: 'pi_L', status: 'lost', balanceTransactions: [{ amount: -899, fee: 1500 }] }), 'test', 'evt_d');
    expect(row).toMatchObject({ type: 'dispute', status: 'lost', fundsState: 'withdrawn', disputeFee: 1500, householdId: household.id });
  });

  it('anonymises a deleted user and stays anonymised on re-record (§5.11)', async () => {
    const { admin } = await linked();
    await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(await anonymizeUserLedger(admin.id)).toBe(1);
    const again = await recordInvoice(stripeInvoice({ id: 'in_L', customer: 'cus_L', subscriptionId: 'sub_L' }), 'test', 'payment', null);
    expect(again).toMatchObject({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL });
  });
});
```
Note: the int test's `createSubscriptionRow` sets `purchasedByUserId`; `anonymizeUserLedger` does not touch subscriptions (Task 6.5 does).

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/ledger.test.ts` → FAIL.

- [ ] **Step 4: Implement `ledger.ts`**

```ts
import Stripe from 'stripe';
import { UniqueConstraintError } from 'sequelize';
import { BillingCustomer, BillingSubscription, BillingTransaction, Household, User } from '../../database/models';
import type { FundsState, LedgerType } from '../../database/models/BillingTransaction';
import logger from '../../shared/utils/logger';
import { getStripe } from './config';
import { livemodeOf } from './mode';
import { raiseReviewItem } from './review';
import { idOf } from './sync';
import type { BillingMode } from './types';

export const ANONYMIZED_EMAIL = 'deleted user';

export interface LedgerLink {
  householdId: string | null;
  userId: string | null;
  subscriptionId: string | null;
  matchStatus: 'matched' | 'unmatched';
  householdNameSnapshot: string | null;
  payerEmailSnapshot: string | null;
}

export type LedgerFields = Partial<{
  status: string; billingReason: string | null; amount: number; fee: number | null; net: number | null; disputeFee: number | null;
  fundsState: FundsState | null; currency: string; householdId: string | null; userId: string | null; subscriptionId: string | null;
  matchStatus: 'matched' | 'unmatched'; householdNameSnapshot: string | null; payerEmailSnapshot: string | null;
  providerInvoiceId: string | null; providerChargeId: string | null; receiptUrl: string | null; description: string | null;
  occurredAt: Date; lastEventId: string | null;
}>;

type Ref = string | { id: string } | null | undefined;
const toDate = (sec: number) => new Date(sec * 1000);

export function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  return idOf(inv.parent?.subscription_details?.subscription as Ref);
}

async function snapshots(householdId: string | null, userId: string | null, email: string | null | undefined) {
  const household = householdId ? await Household.findByPk(householdId, { paranoid: false, attributes: ['name'] }) : null;
  const user = !email && userId ? await User.findByPk(userId, { paranoid: false, attributes: ['email'] }) : null;
  return { householdNameSnapshot: household?.name ?? null, payerEmailSnapshot: email ?? user?.email ?? null };
}

const UNMATCHED = (email: string | null): LedgerLink => ({
  householdId: null, userId: null, subscriptionId: null, matchStatus: 'unmatched', householdNameSnapshot: null, payerEmailSnapshot: email,
});

async function linkCustomer(customerId: string | null, livemode: boolean, email: string | null): Promise<LedgerLink | null> {
  if (!customerId) return null;
  const c = await BillingCustomer.findOne({ where: { provider: 'stripe', livemode, providerCustomerId: customerId } });
  if (!c) return null;
  return { householdId: c.householdId, userId: null, subscriptionId: null, matchStatus: 'matched', ...(await snapshots(c.householdId, null, email ?? c.billingEmail)) };
}

export async function linkInvoice(inv: Stripe.Invoice, mode: BillingMode): Promise<LedgerLink> {
  const livemode = livemodeOf(mode);
  const subId = invoiceSubscriptionId(inv);
  if (subId) {
    const sub = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
    if (sub) {
      return {
        householdId: sub.householdId, userId: sub.purchasedByUserId, subscriptionId: sub.id, matchStatus: 'matched',
        ...(await snapshots(sub.householdId, sub.purchasedByUserId, inv.customer_email)),
      };
    }
  }
  return (await linkCustomer(idOf(inv.customer as Ref), livemode, inv.customer_email ?? null)) ?? UNMATCHED(inv.customer_email ?? null);
}

export async function fetchPaymentFees(invoiceId: string, mode: BillingMode): Promise<{ fee: number | null; net: number | null; chargeId: string; receiptUrl: string | null } | null> {
  const stripe = getStripe(mode);
  // Verify at implementation time: invoice → InvoicePayment → payment.payment_intent → latest_charge → balance_transaction
  // (https://docs.stripe.com/api/invoice-payment/list.md). Expansion is limited to 4 levels, so the charge is retrieved separately.
  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 10, expand: ['data.payment.payment_intent'] });
  const paid = payments.data.find((p) => p.status === 'paid');
  const pi = paid?.payment?.payment_intent;
  if (!pi || typeof pi === 'string') return null;
  const chargeId = idOf(pi.latest_charge as Ref);
  if (!chargeId) return null;
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === 'string') return { fee: null, net: null, chargeId, receiptUrl: charge.receipt_url ?? null };
  return { fee: bt.fee, net: bt.net, chargeId, receiptUrl: charge.receipt_url ?? null };
}

export function mergeLedgerFields(existing: BillingTransaction | null, fields: LedgerFields): LedgerFields {
  const out: LedgerFields = { ...fields };
  if (!existing) return out;
  for (const key of ['fee', 'net', 'providerChargeId', 'receiptUrl', 'disputeFee', 'providerInvoiceId'] as const) {
    if ((out[key] === null || out[key] === undefined) && existing[key] !== null && existing[key] !== undefined) {
      (out as Record<string, unknown>)[key] = existing[key];
    }
  }
  if (existing.matchStatus === 'matched' && out.matchStatus === 'unmatched') {
    out.matchStatus = 'matched';
    out.householdId = existing.householdId;
    out.userId = existing.userId;
    out.subscriptionId = existing.subscriptionId;
    out.householdNameSnapshot = existing.householdNameSnapshot;
    out.payerEmailSnapshot = existing.payerEmailSnapshot;
  }
  if (existing.payerEmailSnapshot === ANONYMIZED_EMAIL) {
    out.userId = null;
    out.payerEmailSnapshot = ANONYMIZED_EMAIL;
  }
  return out;
}

export async function upsertLedgerRow(
  identity: { provider: 'stripe' | 'apple' | 'google'; livemode: boolean; type: LedgerType; providerObjectId: string },
  fields: LedgerFields,
): Promise<BillingTransaction> {
  const existing = await BillingTransaction.findOne({ where: identity });
  if (existing) return existing.update(mergeLedgerFields(existing, fields));
  try {
    return await BillingTransaction.create({ ...identity, ...fields });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const raced = (await BillingTransaction.findOne({ where: identity }))!;
    return raced.update(mergeLedgerFields(raced, fields));
  }
}

export async function recordInvoice(inv: Stripe.Invoice, mode: BillingMode, type: 'payment' | 'failed_payment', eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const link = await linkInvoice(inv, mode);
  let fees: Awaited<ReturnType<typeof fetchPaymentFees>> = null;
  if (type === 'payment') {
    fees = await fetchPaymentFees(inv.id!, mode).catch((err: Error) => {
      logger.warn(`[Billing] fee lookup failed for ${inv.id}: ${err.message}`);
      return null;
    });
  }
  const at = type === 'payment'
    ? inv.status_transitions?.paid_at ?? inv.created
    : inv.status_transitions?.finalized_at ?? inv.created;
  const row = await upsertLedgerRow({ provider: 'stripe', livemode, type, providerObjectId: inv.id! }, {
    status: type === 'payment' ? 'paid' : 'failed',
    billingReason: inv.billing_reason ?? null,
    amount: type === 'payment' ? inv.amount_paid : inv.amount_due,
    fee: fees?.fee ?? null,
    net: fees?.net ?? null,
    currency: inv.currency,
    ...link,
    providerInvoiceId: inv.id!,
    providerChargeId: fees?.chargeId ?? null,
    receiptUrl: fees?.receiptUrl ?? null,
    description: (inv.lines?.data?.[0]?.description ?? inv.billing_reason ?? '').slice(0, 500) || null,
    occurredAt: toDate(at),
    lastEventId: eventId,
  });
  if (row.matchStatus === 'unmatched') {
    await raiseReviewItem({ livemode, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: inv.id!, after: { customer: idOf(inv.customer as Ref) } });
  }
  return row;
}

export async function resolvePaymentLink(paymentIntentId: string | null, chargeId: string | null, mode: BillingMode): Promise<LedgerLink & { invoiceId: string | null }> {
  const stripe = getStripe(mode);
  if (paymentIntentId) {
    // Verify at implementation time: filtering invoice payments by payment intent
    // (https://docs.stripe.com/billing/subscriptions/webhooks.md#refund-events).
    const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1, expand: ['data.invoice'] });
    const inv = payments.data[0]?.invoice;
    if (inv && typeof inv === 'object') return { ...(await linkInvoice(inv as Stripe.Invoice, mode)), invoiceId: inv.id ?? null };
  }
  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId);
    const link = await linkCustomer(idOf(charge.customer as Ref), livemodeOf(mode), charge.billing_details?.email ?? null);
    if (link) return { ...link, invoiceId: null };
  }
  return { ...UNMATCHED(null), invoiceId: null };
}

export async function recordRefund(refund: Stripe.Refund, mode: BillingMode, eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const chargeId = idOf(refund.charge as Ref);
  const { invoiceId, ...link } = await resolvePaymentLink(idOf(refund.payment_intent as Ref), chargeId, mode);
  const row = await upsertLedgerRow({ provider: 'stripe', livemode, type: 'refund', providerObjectId: refund.id }, {
    status: refund.status ?? 'pending', amount: refund.amount, currency: refund.currency, ...link,
    providerInvoiceId: invoiceId, providerChargeId: chargeId, description: refund.reason ? `refund: ${refund.reason}` : 'refund',
    occurredAt: toDate(refund.created), lastEventId: eventId,
  });
  if (row.matchStatus === 'unmatched') await raiseReviewItem({ livemode, kind: 'unmatched_refund', entityType: 'transaction', providerObjectId: refund.id });
  return row;
}

export function disputeFunds(d: Stripe.Dispute): { fundsState: FundsState; disputeFee: number } {
  const bts = (d.balance_transactions ?? []) as Array<{ amount: number; fee: number }>;
  const withdrawn = bts.some((b) => b.amount < 0);
  const reinstated = bts.some((b) => b.amount > 0);
  return {
    fundsState: !withdrawn ? 'none' : reinstated ? 'reinstated' : 'withdrawn',
    disputeFee: bts.reduce((sum, b) => sum + b.fee, 0),
  };
}

export async function recordDispute(d: Stripe.Dispute, mode: BillingMode, eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const chargeId = idOf(d.charge as Ref);
  const { invoiceId, ...link } = await resolvePaymentLink(idOf(d.payment_intent as Ref), chargeId, mode);
  const funds = disputeFunds(d);
  return upsertLedgerRow({ provider: 'stripe', livemode, type: 'dispute', providerObjectId: d.id }, {
    status: d.status, amount: d.amount, currency: d.currency, disputeFee: funds.disputeFee, fundsState: funds.fundsState, ...link,
    providerInvoiceId: invoiceId, providerChargeId: chargeId, description: `dispute: ${d.reason}`, occurredAt: toDate(d.created), lastEventId: eventId,
  });
}

export async function anonymizeUserLedger(userId: string): Promise<number> {
  const [count] = await BillingTransaction.update({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL }, { where: { userId } });
  return count;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/ledger.test.ts && npm run test:int -- src/modules/billing/__int__/ledger.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): ledger writes with household/user linking, fees, refunds and disputes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 6.2: Event dispatch table (§8.5)

**Files:**
- Create: `server/src/modules/billing/handlers.ts`
- Test: `server/src/modules/billing/__tests__/handlers.test.ts`

**Interfaces:**
- Consumes: `upsertSubscription` (5.3); `recordInvoice`, `recordRefund`, `recordDispute`, `linkInvoice`, `invoiceSubscriptionId` (6.1); `notifyHouseholdAdmins`, `alertStaff` (5.1); `raiseReviewItem` (5.1).
- Produces: `type HandlerOutcome = 'processed' | 'ignored'`; `envOfEventObject(obj: unknown): string | undefined`; `dispatchEvent(event: Stripe.Event, mode: BillingMode): Promise<HandlerOutcome>`; `NOTIFY_FAILED_REASONS = ['subscription_cycle', 'subscription_create']`.

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__tests__/handlers.test.ts`:
```ts
jest.mock('../sync', () => ({ upsertSubscription: jest.fn(), idOf: (x: any) => (x ? (typeof x === 'string' ? x : x.id) : null) }));
jest.mock('../ledger', () => ({
  recordInvoice: jest.fn(), recordRefund: jest.fn(), recordDispute: jest.fn(), linkInvoice: jest.fn(),
  invoiceSubscriptionId: (inv: any) => inv.parent?.subscription_details?.subscription ?? null,
}));
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));
jest.mock('../review', () => ({ raiseReviewItem: jest.fn() }));
jest.mock('../../../database/models', () => ({
  BillingCheckoutSession: { update: jest.fn() }, BillingCustomer: { update: jest.fn() }, BillingSubscription: { findOne: jest.fn() },
}));

import * as models from '../../../database/models';
import { upsertSubscription } from '../sync';
import { recordInvoice, recordRefund, recordDispute, linkInvoice } from '../ledger';
import { notifyHouseholdAdmins, alertStaff } from '../notify';
import { raiseReviewItem } from '../review';
import { dispatchEvent, envOfEventObject } from '../handlers';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { stripeEvent, stripeCheckoutSession, stripeSubscription, stripeInvoice, stripeRefund, stripeDispute } from '../../../test/billing/fixtures';

beforeEach(() => { jest.clearAllMocks(); installStripeMock('test'); });

describe('dispatchEvent (§8.5)', () => {
  it('checkout completed/async events mark the row complete and upsert', async () => {
    for (const t of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed']) {
      await dispatchEvent(stripeEvent(t, stripeCheckoutSession({ id: 'cs_test_1', status: 'complete', subscription: 'sub_1' }), { created: 77 }), 'test');
    }
    expect(models.BillingCheckoutSession.update).toHaveBeenCalledWith({ status: 'complete' }, { where: { providerSessionId: 'cs_test_1' } });
    expect(upsertSubscription).toHaveBeenCalledWith('sub_1', 'test', { eventCreated: 77 });
  });

  it('checkout expired marks the row expired', async () => {
    await dispatchEvent(stripeEvent('checkout.session.expired', stripeCheckoutSession({ id: 'cs_test_2', status: 'expired' })), 'test');
    expect(models.BillingCheckoutSession.update).toHaveBeenCalledWith({ status: 'expired' }, expect.objectContaining({ where: expect.objectContaining({ providerSessionId: 'cs_test_2' }) }));
  });

  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.pending_update_applied'])('%s upserts', async (t) => {
    await dispatchEvent(stripeEvent(t, stripeSubscription({ id: 'sub_9' })), 'test');
    expect(upsertSubscription).toHaveBeenCalledWith('sub_9', 'test', expect.anything());
  });

  it('pending_update_expired upserts and notifies the admin (T8)', async () => {
    (upsertSubscription as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('customer.subscription.pending_update_expired', stripeSubscription({ id: 'sub_9' })), 'test');
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith('h1', 'billing_plan_change_failed', expect.any(String), expect.any(String), expect.anything());
  });

  it('invoice.paid records a payment then upserts', async () => {
    await dispatchEvent(stripeEvent('invoice.paid', stripeInvoice({ id: 'in_1', subscriptionId: 'sub_1' }), { id: 'evt_p' }), 'test');
    expect(recordInvoice).toHaveBeenCalledWith(expect.objectContaining({ id: 'in_1' }), 'test', 'payment', 'evt_p');
    expect(upsertSubscription).toHaveBeenCalledWith('sub_1', 'test', expect.anything());
  });

  it.each([
    ['subscription_cycle', true], ['subscription_create', true], ['subscription_update', false], ['manual', false],
  ])('invoice.payment_failed with %s notifies=%s', async (reason, notifies) => {
    (recordInvoice as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('invoice.payment_failed', stripeInvoice({ billingReason: reason, status: 'open' })), 'test');
    expect(recordInvoice).toHaveBeenCalledWith(expect.anything(), 'test', 'failed_payment', expect.any(String));
    expect((notifyHouseholdAdmins as jest.Mock).mock.calls.length > 0).toBe(notifies);
  });

  it('payment_action_required notifies with the hosted invoice URL', async () => {
    (linkInvoice as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent('invoice.payment_action_required', stripeInvoice({ hostedInvoiceUrl: 'https://invoice.stripe.com/i/z' })), 'test');
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith('h1', 'billing_action_required', expect.any(String), expect.stringContaining('https://invoice.stripe.com/i/z'), expect.objectContaining({ url: 'https://invoice.stripe.com/i/z' }));
  });

  it.each(['refund.created', 'refund.updated', 'refund.failed'])('%s records a refund', async (t) => {
    await dispatchEvent(stripeEvent(t, stripeRefund({ id: 're_1' })), 'test');
    expect(recordRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 're_1' }), 'test', expect.any(String));
  });

  it('dispute created raises review and alerts staff', async () => {
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1', providerObjectId: 'dp_1' });
    await dispatchEvent(stripeEvent('charge.dispute.created', stripeDispute({ id: 'dp_1' })), 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispute_opened', providerObjectId: 'dp_1' }));
    expect(alertStaff).toHaveBeenCalled();
  });

  it('dispute closed as lost sets cancel_at_period_end on the allowed subscription (L4)', async () => {
    const s = installStripeMock('test');
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1', providerObjectId: 'dp_2' });
    (models.BillingSubscription.findOne as jest.Mock).mockResolvedValue({ providerSubscriptionId: 'sub_7', cancelAtPeriodEnd: false });
    s.subscriptions.update.mockResolvedValue({});
    await dispatchEvent(stripeEvent('charge.dispute.closed', stripeDispute({ id: 'dp_2', status: 'lost' })), 'test');
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_7', { cancel_at_period_end: true }, { idempotencyKey: 'dispute-lost:dp_2' });
    expect(upsertSubscription).toHaveBeenCalledWith('sub_7', 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispute_lost' }));
  });

  it.each(['charge.dispute.updated', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'])('%s records the dispute', async (t) => {
    (recordDispute as jest.Mock).mockResolvedValue({ householdId: 'h1' });
    await dispatchEvent(stripeEvent(t, stripeDispute()), 'test');
    expect(recordDispute).toHaveBeenCalled();
  });

  it('early fraud warning raises review and alerts', async () => {
    await dispatchEvent(stripeEvent('radar.early_fraud_warning.created', { id: 'issfr_1', charge: 'ch_1' }), 'test');
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'early_fraud_warning' }));
    expect(alertStaff).toHaveBeenCalled();
  });

  it('customer.updated keeps billing_email in sync', async () => {
    await dispatchEvent(stripeEvent('customer.updated', { id: 'cus_1', email: 'new@x' }), 'test');
    expect(models.BillingCustomer.update).toHaveBeenCalledWith({ billingEmail: 'new@x' }, { where: { provider: 'stripe', livemode: false, providerCustomerId: 'cus_1' } });
  });

  it('anything else is ignored', async () => {
    expect(await dispatchEvent(stripeEvent('payment_intent.created', {}), 'test')).toBe('ignored');
  });

  it('reads the env tag from metadata or the invoice parent', () => {
    expect(envOfEventObject({ metadata: { env: 'prod' } })).toBe('prod');
    expect(envOfEventObject(stripeInvoice({ subscriptionEnv: 'staging' }))).toBe('staging');
    expect(envOfEventObject({ id: 're_1' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/modules/billing/__tests__/handlers.test.ts` → FAIL.

- [ ] **Step 3: Implement `handlers.ts`**

```ts
import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingCheckoutSession, BillingCustomer, BillingSubscription, BillingTransaction } from '../../database/models';
import { getStripe } from './config';
import { formatUsd } from './copy';
import { invoiceSubscriptionId, linkInvoice, recordDispute, recordInvoice, recordRefund } from './ledger';
import { livemodeOf } from './mode';
import { alertStaff, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { idOf, upsertSubscription } from './sync';
import type { BillingMode } from './types';

export type HandlerOutcome = 'processed' | 'ignored';
export const NOTIFY_FAILED_REASONS = ['subscription_cycle', 'subscription_create'];
type Ref = string | { id: string } | null | undefined;

export function envOfEventObject(obj: unknown): string | undefined {
  const o = obj as { metadata?: Record<string, string> | null; parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null };
  return o?.metadata?.env ?? o?.parent?.subscription_details?.metadata?.env ?? undefined;
}

async function handleLostDispute(row: BillingTransaction, mode: BillingMode): Promise<void> {
  const livemode = livemodeOf(mode);
  const sub = await BillingSubscription.findOne({
    where: { householdId: row.householdId, livemode, provider: 'stripe', status: { [Op.in]: ['active', 'trialing', 'past_due'] } },
  });
  if (sub && !sub.cancelAtPeriodEnd) {
    await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `dispute-lost:${row.providerObjectId}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
  }
  await raiseReviewItem({ livemode, kind: 'dispute_lost', entityType: 'dispute', entityId: row.householdId, providerObjectId: row.providerObjectId, after: { subscription: sub?.providerSubscriptionId ?? null } });
}

export async function dispatchEvent(event: Stripe.Event, mode: BillingMode): Promise<HandlerOutcome> {
  const obj = event.data.object as unknown;
  const livemode = livemodeOf(mode);
  const opts = { eventCreated: event.created };

  switch (event.type as string) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const session = obj as Stripe.Checkout.Session;
      await BillingCheckoutSession.update({ status: 'complete' }, { where: { providerSessionId: session.id } });
      const subId = idOf(session.subscription as Ref);
      if (subId) await upsertSubscription(subId, mode, opts);
      return 'processed';
    }
    case 'checkout.session.expired': {
      const session = obj as Stripe.Checkout.Session;
      await BillingCheckoutSession.update({ status: 'expired' }, { where: { providerSessionId: session.id, status: { [Op.in]: ['open', 'creating'] } } });
      return 'processed';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
      await upsertSubscription((obj as Stripe.Subscription).id, mode, opts);
      return 'processed';
    case 'customer.subscription.pending_update_expired': {
      const row = await upsertSubscription((obj as Stripe.Subscription).id, mode, opts);
      if (row) {
        await notifyHouseholdAdmins(row.householdId, 'billing_plan_change_failed', 'Your plan change did not go through',
          'The payment for your plan change was not completed, so your household stays on its current plan. You can try again from Subscription.',
          { type: 'billing_plan_change_failed' });
      }
      return 'processed';
    }
    case 'invoice.paid': {
      const inv = obj as Stripe.Invoice;
      await recordInvoice(inv, mode, 'payment', event.id);
      const subId = invoiceSubscriptionId(inv);
      if (subId) await upsertSubscription(subId, mode, opts);
      return 'processed';
    }
    case 'invoice.payment_failed': {
      const inv = obj as Stripe.Invoice;
      const row = await recordInvoice(inv, mode, 'failed_payment', event.id);
      if (row.householdId && NOTIFY_FAILED_REASONS.includes(inv.billing_reason ?? '')) {
        await notifyHouseholdAdmins(row.householdId, 'billing_payment_failed', 'Your Rootaroo payment failed',
          `We couldn't charge ${formatUsd(inv.amount_due)}. Update your card to keep access: ${inv.hosted_invoice_url ?? 'More → Subscription → Manage subscription'}`,
          { type: 'billing_payment_failed', url: inv.hosted_invoice_url ?? null });
      }
      const subId = invoiceSubscriptionId(inv);
      if (subId) await upsertSubscription(subId, mode, opts);
      return 'processed';
    }
    case 'invoice.payment_action_required': {
      const inv = obj as Stripe.Invoice;
      const link = await linkInvoice(inv, mode);
      if (link.householdId) {
        await notifyHouseholdAdmins(link.householdId, 'billing_action_required', 'Confirm your Rootaroo payment',
          `Your bank needs you to confirm this payment: ${inv.hosted_invoice_url ?? ''}`, { type: 'billing_action_required', url: inv.hosted_invoice_url ?? null });
      }
      return 'processed';
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await recordRefund(obj as Stripe.Refund, mode, event.id);
      return 'processed';
    case 'charge.dispute.created': {
      const d = obj as Stripe.Dispute;
      const row = await recordDispute(d, mode, event.id);
      await raiseReviewItem({ livemode, kind: 'dispute_opened', entityType: 'dispute', entityId: row.householdId, providerObjectId: d.id, after: { amount: d.amount, reason: d.reason } });
      await alertStaff('Dispute opened', `Dispute ${d.id} for ${formatUsd(d.amount)} (${d.reason}), household ${row.householdId ?? 'unmatched'}.`);
      return 'processed';
    }
    case 'charge.dispute.updated':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
      await recordDispute(obj as Stripe.Dispute, mode, event.id);
      return 'processed';
    case 'charge.dispute.closed': {
      const d = obj as Stripe.Dispute;
      const row = await recordDispute(d, mode, event.id);
      if (d.status === 'lost' && row.householdId) await handleLostDispute(row, mode);
      return 'processed';
    }
    case 'radar.early_fraud_warning.created': {
      const w = obj as { id: string; charge?: Ref };
      await raiseReviewItem({ livemode, kind: 'early_fraud_warning', entityType: 'early_fraud_warning', providerObjectId: w.id, after: { charge: idOf(w.charge) } });
      await alertStaff('Early fraud warning', `Radar early fraud warning ${w.id} on charge ${idOf(w.charge) ?? 'unknown'}.`);
      return 'processed';
    }
    case 'customer.updated': {
      const c = obj as Stripe.Customer;
      await BillingCustomer.update({ billingEmail: c.email ?? null }, { where: { provider: 'stripe', livemode, providerCustomerId: c.id } });
      return 'processed';
    }
    default:
      return 'ignored';
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx jest src/modules/billing/__tests__/handlers.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): webhook event dispatch table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 6.3: Worker, event sweep and its job (§8.4 worker, §10 event sweep)

**Files:**
- Create: `server/src/modules/billing/worker.ts`, `server/src/jobs/billing-event-sweep.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/modules/billing/__int__/worker.int.test.ts`

**Interfaces:**
- Consumes: `dispatchEvent`, `envOfEventObject` (6.2); `raiseReviewItem`, `alertStaff` (5.1); `withLock` (2.4).
- Produces:
  - `MAX_ATTEMPTS = 8`, `STALE_PROCESSING_MS = 10 * 60_000`, `backoffMs(attempts: number): number` (2^attempts minutes, capped at 60)
  - `enqueueEvent(id: string): void`, `processEvent(id: string): Promise<'processed' | 'ignored' | 'failed' | 'skipped'>`
  - `sweepEvents(now?: Date): Promise<{ requeued: number; dead: number; reset: number }>`
  - `__drainForTests(): Promise<void>`
  - `startBillingEventSweepJob(): void` (every minute, lock `billing:job:event-sweep:all`)
  - Hook for Phase 2–3: `registerProviderDispatcher(provider: 'apple' | 'google', fn: (row: BillingEvent) => Promise<'processed' | 'ignored'>): void`

- [ ] **Step 1: Write the failing integration test**

`server/src/modules/billing/__int__/worker.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));
jest.mock('../handlers', () => {
  const actual = jest.requireActual('../handlers');
  return { ...actual, dispatchEvent: jest.fn() };
});

import { setupAssociations, BillingEvent, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { stripeEvent, stripeSubscription } from '../../../test/billing/fixtures';
import { processEvent, sweepEvents, enqueueEvent, __drainForTests, backoffMs } from '../worker';
import { dispatchEvent } from '../handlers';
import { alertStaff } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test'); (dispatchEvent as jest.Mock).mockReset(); });
afterAll(() => closeIntResources());

const store = (event: unknown, extra: Record<string, unknown> = {}) => BillingEvent.create({
  provider: 'stripe', livemode: false, providerEventId: (event as any).id, type: (event as any).type, payload: event, receivedAt: new Date(), ...extra,
});

describe('worker', () => {
  it('claims, dispatches and marks processed; a second claim is skipped', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    const row = await store(stripeEvent('customer.subscription.updated', stripeSubscription()));
    expect(await processEvent(row.id)).toBe('processed');
    expect(await processEvent(row.id)).toBe('skipped');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((await BillingEvent.findByPk(row.id))!.processedAt).not.toBeNull();
  });

  it('marks ignored when the env tag differs (§4.1)', async () => {
    const row = await store(stripeEvent('customer.subscription.updated', stripeSubscription({ env: 'prod' })));
    expect(await processEvent(row.id)).toBe('ignored');
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('records failures with attempts and last_error', async () => {
    (dispatchEvent as jest.Mock).mockRejectedValue(new Error('stripe timeout'));
    const row = await store(stripeEvent('invoice.paid', {}));
    expect(await processEvent(row.id)).toBe('failed');
    expect(await BillingEvent.findByPk(row.id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'stripe timeout' });
  });

  it('the sweep recovers a crash in processing (T2)', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    const row = await store(stripeEvent('invoice.paid', {}), { status: 'processing', lockedAt: new Date(Date.now() - 11 * 60_000) });
    const res = await sweepEvents();
    await __drainForTests();
    expect(res.reset).toBe(1);
    expect((await BillingEvent.findByPk(row.id))!.status).toBe('processed');
  });

  it('respects exponential backoff and moves attempts >= 8 to dead with review + alert', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(10)).toBe(60 * 60_000);
    const waiting = await store(stripeEvent('invoice.paid', {}), { status: 'failed', attempts: 3 });
    await sweepEvents();
    await __drainForTests();
    expect((await BillingEvent.findByPk(waiting.id))!.status).toBe('failed');
    await sweepEvents(new Date(Date.now() + 9 * 60_000));
    await __drainForTests();
    expect((await BillingEvent.findByPk(waiting.id))!.status).toBe('processed');

    const dead = await store(stripeEvent('invoice.paid', {}), { status: 'failed', attempts: 8 });
    expect((await sweepEvents()).dead).toBe(1);
    expect((await BillingEvent.findByPk(dead.id))!.status).toBe('dead');
    expect(await BillingReconciliationItem.count({ where: { kind: 'dead_event' } })).toBe(1);
    expect(alertStaff).toHaveBeenCalled();
  });

  it('enqueue processes in the background', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('ignored');
    const row = await store(stripeEvent('payment_intent.created', {}));
    enqueueEvent(row.id);
    await __drainForTests();
    expect((await BillingEvent.findByPk(row.id))!.status).toBe('ignored');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/worker.int.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`worker.ts`:
```ts
import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingEvent } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig } from './config';
import { dispatchEvent, envOfEventObject } from './handlers';
import { modeFromLivemode } from './mode';
import { alertStaff } from './notify';
import { raiseReviewItem } from './review';

export const MAX_ATTEMPTS = 8;
export const STALE_PROCESSING_MS = 10 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, 60 * 60_000);
}

type Dispatcher = (row: BillingEvent) => Promise<'processed' | 'ignored'>;
const providerDispatchers: Partial<Record<'apple' | 'google', Dispatcher>> = {};

export function registerProviderDispatcher(provider: 'apple' | 'google', fn: Dispatcher): void {
  providerDispatchers[provider] = fn;
}

const queue: string[] = [];
let draining: Promise<void> | null = null;

export function enqueueEvent(id: string): void {
  queue.push(id);
  if (!draining) {
    draining = (async () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await processEvent(next).catch((err) => logger.error(`[Billing] worker crashed on ${next}:`, err));
      }
    })().finally(() => { draining = null; });
  }
}

export async function __drainForTests(): Promise<void> {
  while (draining) await draining;
}

export async function processEvent(id: string): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  const [claimed] = await BillingEvent.update(
    { status: 'processing', lockedAt: new Date() },
    { where: { id, status: { [Op.in]: ['received', 'failed'] } } },
  );
  if (claimed === 0) return 'skipped';
  const row = (await BillingEvent.findByPk(id))!;
  try {
    let outcome: 'processed' | 'ignored';
    if (row.provider === 'stripe') {
      const event = row.payload as unknown as Stripe.Event;
      const env = envOfEventObject(event.data?.object);
      outcome = env && env !== getBillingConfig().envTag ? 'ignored' : await dispatchEvent(event, modeFromLivemode(row.livemode));
    } else {
      const dispatcher = providerDispatchers[row.provider];
      outcome = dispatcher ? await dispatcher(row) : 'ignored';
    }
    await row.update({ status: outcome, processedAt: new Date(), lockedAt: null, lastError: null });
    return outcome;
  } catch (err) {
    await row.update({ status: 'failed', attempts: row.attempts + 1, lastError: String((err as Error).message ?? err).slice(0, 2000), lockedAt: null });
    logger.warn(`[Billing] event ${row.providerEventId} failed (attempt ${row.attempts}): ${(err as Error).message}`);
    return 'failed';
  }
}

export async function sweepEvents(now: Date = new Date()): Promise<{ requeued: number; dead: number; reset: number }> {
  // 1. stale `processing` rows (crash mid-dispatch) go back to failed with one more attempt
  const stale = await BillingEvent.findAll({ where: { status: 'processing', lockedAt: { [Op.lt]: new Date(now.getTime() - STALE_PROCESSING_MS) } } });
  for (const row of stale) await row.update({ status: 'failed', attempts: row.attempts + 1, lockedAt: null, lastError: 'stale processing lock' });

  // 2. exhausted rows become dead
  const exhausted = await BillingEvent.findAll({ where: { status: 'failed', attempts: { [Op.gte]: MAX_ATTEMPTS } } });
  for (const row of exhausted) {
    await row.update({ status: 'dead' });
    await raiseReviewItem({ livemode: row.livemode, kind: 'dead_event', entityType: 'event', entityId: row.id, providerObjectId: row.providerEventId, after: { type: row.type, lastError: row.lastError } });
  }
  if (exhausted.length > 0) {
    await alertStaff('Dead billing events', exhausted.map((r) => `${r.providerEventId} ${r.type}: ${r.lastError ?? ''}`).join('\n'));
  }

  // 3. re-queue received rows and failed rows whose backoff elapsed
  const candidates = await BillingEvent.findAll({ where: { status: { [Op.in]: ['received', 'failed'] }, attempts: { [Op.lt]: MAX_ATTEMPTS } } });
  let requeued = 0;
  for (const row of candidates) {
    if (row.status === 'failed' && row.updatedAt.getTime() + backoffMs(row.attempts) > now.getTime()) continue;
    enqueueEvent(row.id);
    requeued++;
  }
  return { requeued, dead: exhausted.length, reset: stale.length };
}
```

`server/src/jobs/billing-event-sweep.ts`:
```ts
import cron from 'node-cron';
import { withLock } from '../modules/billing/locks';
import { sweepEvents } from '../modules/billing/worker';
import { LockBusyError } from '../modules/billing/errors';
import logger from '../shared/utils/logger';

export function startBillingEventSweepJob(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const res = await withLock('billing:job:event-sweep:all', 55_000, () => sweepEvents());
      if (res.requeued || res.dead || res.reset) logger.info(`[Billing Sweep] requeued=${res.requeued} dead=${res.dead} reset=${res.reset}`);
    } catch (err) {
      if (!(err instanceof LockBusyError)) logger.error('[Billing Sweep] Failed:', err);
    }
  });
  logger.info('[Billing Sweep] Cron job registered — runs every minute');
}
```
`index.ts`: import and call `startBillingEventSweepJob();` with the other jobs.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/worker.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing server/src/jobs/billing-event-sweep.ts server/src/index.ts
git commit -F - <<'MSG'
feat(billing): event worker with claim, backoff, dead-lettering and minute sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 6.4: Raw-body webhook receivers (§4.4, §8.4 receiver)

**Files:**
- Create: `server/src/modules/billing/webhooks.ts`, `server/src/modules/billing/webhookRoutes.ts`, `server/src/test/billing/webhookSign.ts`
- Modify: `server/src/app.ts` (mount before the rate limiter and `express.json()`; name the limiter wrappers)
- Test: `server/src/modules/billing/__int__/webhooks.int.test.ts`

**Interfaces:**
- Consumes: `getBillingConfig`, `getStripe` (2.3); `enqueueEvent` (6.3).
- Produces: `class WebhookVerificationError extends Error`; `verifyStripeEvent(raw: Buffer, signature: string | undefined, mode: BillingMode): Stripe.Event`; `stripeWebhookHandler(mode: BillingMode): RequestHandler`; default export router with `POST /stripe/test`, `POST /stripe/live` mounted at `/api/v1/billing/webhooks`; helper `signedWebhook(event: unknown, secret: string, timestamp?: number): { body: string; signature: string }`.

- [ ] **Step 1: Write the signing helper**

`server/src/test/billing/webhookSign.ts`:
```ts
import Stripe from 'stripe';
import { fakeKey } from './secrets';

const stripe = new Stripe(fakeKey('sk_test'));

/** A real Stripe-Signature header for `event`, as Stripe would send it. */
export function signedWebhook(event: unknown, secret: string, timestamp?: number): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret, ...(timestamp ? { timestamp } : {}) });
  return { body, signature };
}
```

- [ ] **Step 2: Write the failing integration test**

`server/src/modules/billing/__int__/webhooks.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import redis from '../../../config/redis';
import { setupAssociations, BillingEvent, BillingSubscription } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { fakeKey, fakeWebhookSecret } from '../../../test/billing/secrets';
import { signedWebhook } from '../../../test/billing/webhookSign';
import { stripeEvent, stripeSubscription, stripeCheckoutSession } from '../../../test/billing/fixtures';
import { __drainForTests } from '../worker';
import { syncCheckout } from '../checkout';

const SECRET_A = fakeWebhookSecret('rotA');
const SECRET_B = fakeWebhookSecret('rotB');
let s: StripeMock;

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  s = installStripeMock('test', testBillingConfig({ modes: { test: { secretKey: fakeKey('sk_test'), webhookSecrets: [SECRET_A, SECRET_B] }, live: null } }));
});
afterAll(() => closeIntResources());

const send = (event: unknown, opts: { secret?: string; path?: string; timestamp?: number; contentType?: string } = {}) => {
  const { body, signature } = signedWebhook(event, opts.secret ?? SECRET_A, opts.timestamp);
  return request(app).post(opts.path ?? '/api/v1/billing/webhooks/stripe/test')
    .set('Content-Type', opts.contentType ?? 'application/json').set('Stripe-Signature', signature).send(body);
};
const customerUpdated = (id = `evt_${Math.random().toString(36).slice(2)}`) => stripeEvent('customer.updated', { id: 'cus_1', email: 'x@y' }, { id });

describe('Stripe webhook receiver (B5)', () => {
  it('accepts a valid event, persists it and processes it', async () => {
    const res = await send(customerUpdated('evt_ok'));
    expect(res.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.findOne({ where: { providerEventId: 'evt_ok' } })).toMatchObject({ status: 'processed', livemode: false });
  });

  it('accepts the second secret during rotation', async () => {
    expect((await send(customerUpdated(), { secret: SECRET_B })).status).toBe(200);
  });

  it('400 on a bad or missing signature, no row', async () => {
    expect((await send(customerUpdated(), { secret: fakeWebhookSecret('wrong') })).status).toBe(400);
    const r = await request(app).post('/api/v1/billing/webhooks/stripe/test').set('Content-Type', 'application/json').send('{}');
    expect(r.status).toBe(400);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('400 on a replayed event outside the 300 s tolerance', async () => {
    expect((await send(customerUpdated(), { timestamp: Math.floor(Date.now() / 1000) - 400 })).status).toBe(400);
  });

  it('400 when event.livemode does not match the endpoint (B3)', async () => {
    expect((await send(stripeEvent('customer.updated', { id: 'cus_1' }, { livemode: true }))).status).toBe(400);
  });

  it('400 on the live endpoint when live mode is not configured', async () => {
    expect((await send(customerUpdated(), { path: '/api/v1/billing/webhooks/stripe/live' })).status).toBe(400);
  });

  it('duplicate delivery: 200 both times, processed once', async () => {
    await send(customerUpdated('evt_dup'));
    const second = await send(customerUpdated('evt_dup'));
    expect(second.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.count({ where: { providerEventId: 'evt_dup' } })).toBe(1);
  });

  it('concurrent duplicate deliveries both get 200 and one row (Review Focus 1)', async () => {
    const [a, b] = await Promise.all([send(customerUpdated('evt_race')), send(customerUpdated('evt_race'))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await BillingEvent.count({ where: { providerEventId: 'evt_race' } })).toBe(1);
  });

  it('rejects wrong content-type / oversized body (Review Focus 2)', async () => {
    expect((await send(customerUpdated(), { contentType: 'text/plain' })).status).toBe(400);
    const big = { ...customerUpdated(), padding: 'x'.repeat(1_100_000) };
    expect((await send(big)).status).toBe(413);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('updated before created converges (T5)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T5' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 7 }));
    await send(stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 7 }), { created: 200 }));
    await send(stripeEvent('customer.subscription.created', stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 5 }), { created: 100 }));
    await __drainForTests();
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_T5' } })).toMatchObject({ seats: 7, eventWatermark: 200 });
  });

  it('concurrent webhook and app sync yield one correct row (T1)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T1' });
    const session = stripeCheckoutSession({ id: 'cs_test_T1', status: 'complete', clientReferenceId: household.id, customer: 'cus_T1', subscription: 'sub_T1' });
    s.checkout.sessions.retrieve.mockResolvedValue(session);
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T1', customer: 'cus_T1' }));
    await Promise.all([send(stripeEvent('checkout.session.completed', session)), syncCheckout(admin.id, 'cs_test_T1')]);
    await __drainForTests();
    expect(await BillingSubscription.count({ where: { providerSubscriptionId: 'sub_T1' } })).toBe(1);
  });
});

describe('webhook routes are not rate limited (T9)', () => {
  it('are mounted before the general limiter and before express.json()', () => {
    const stack: Array<{ name: string; regexp: RegExp }> = (app as any)._router.stack;
    const webhook = stack.findIndex((l) => l.name === 'router' && l.regexp.test('/api/v1/billing/webhooks/stripe/test'));
    const limiter = stack.findIndex((l) => l.name === 'rateLimitGate');
    const json = stack.findIndex((l) => l.name === 'jsonParser');
    expect(webhook).toBeGreaterThan(-1);
    expect(webhook).toBeLessThan(limiter);
    expect(webhook).toBeLessThan(json);
  });

  it('a burst of 120 deliveries never gets 429 when Redis is up', async () => {
    if (redis.status !== 'ready') return; // limiter fails open without Redis; structural test above covers it
    const results = await Promise.all(Array.from({ length: 120 }, () => send(customerUpdated())));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/webhooks.int.test.ts` → FAIL (404).

- [ ] **Step 4: Implement**

`webhooks.ts`:
```ts
import Stripe from 'stripe';
import { Request, Response, RequestHandler } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { BillingEvent } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { livemodeOf } from './mode';
import { enqueueEvent } from './worker';
import type { BillingMode } from './types';

export class WebhookVerificationError extends Error {}

const TOLERANCE_SEC = 300;

export function verifyStripeEvent(raw: Buffer, signature: string | undefined, mode: BillingMode): Stripe.Event {
  const modeCfg = getBillingConfig().modes[mode];
  if (!modeCfg || modeCfg.webhookSecrets.length === 0) throw new WebhookVerificationError(`${mode} webhooks are not configured`);
  if (!signature) throw new WebhookVerificationError('missing Stripe-Signature');
  const stripe = getStripe(mode);
  for (const secret of modeCfg.webhookSecrets) {
    try {
      return stripe.webhooks.constructEvent(raw, signature, secret, TOLERANCE_SEC);
    } catch {
      // try the next secret (rotation)
    }
  }
  throw new WebhookVerificationError('signature verification failed');
}

/** Verify → persist → 200 → enqueue. Finishes in milliseconds; never calls Stripe (§8.4). */
export function stripeWebhookHandler(mode: BillingMode): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ success: false, error: 'Expected application/json' });
      return;
    }
    let event: Stripe.Event;
    try {
      event = verifyStripeEvent(req.body, req.header('stripe-signature'), mode);
    } catch (err) {
      logger.warn(`[Billing] ${mode} webhook rejected: ${(err as Error).message}`);
      res.status(400).json({ success: false, error: 'Invalid signature' });
      return;
    }
    if (event.livemode !== livemodeOf(mode)) {
      res.status(400).json({ success: false, error: 'Mode mismatch' });
      return;
    }
    try {
      const row = await BillingEvent.create({
        provider: 'stripe', livemode: event.livemode, providerEventId: event.id, type: event.type,
        payload: event as unknown as Record<string, unknown>, status: 'received', attempts: 0, receivedAt: new Date(),
      });
      res.status(200).json({ received: true });
      enqueueEvent(row.id);
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      logger.error(`[Billing] failed to persist ${event.id}:`, err);
      res.status(500).json({ success: false, error: 'Temporary failure' }); // Stripe retries
    }
  };
}
```

`webhookRoutes.ts`:
```ts
import express, { Router, Request, Response, NextFunction } from 'express';
import { stripeWebhookHandler } from './webhooks';

const router = Router();
const raw = express.raw({ type: 'application/json', limit: '1mb' });

router.post('/stripe/test', raw, stripeWebhookHandler('test'));
router.post('/stripe/live', raw, stripeWebhookHandler('live'));

// body-parser errors (413 too large, 400 bad encoding) as plain JSON, never the global 500.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status === 413 ? 413 : 400).json({ success: false, error: err.type ?? 'Bad request' });
});

export default router;
```
Phase 2–3 receivers (Task 11.x) are added to this same router.

`app.ts`:
- import `billingWebhookRouter from './modules/billing/webhookRoutes'`.
- directly after `app.use(compression());` and **before** the `// ── Rate Limiting ──` section:
```ts
// ── Billing webhooks ──
// Raw body (signature verification), no rate limit (renewal-day bursts, T9),
// so they are mounted before the limiter and before express.json() (§4.4).
app.use('/api/v1/billing/webhooks', billingWebhookRouter);
```
- name the limiter wrappers so the stack test can find them:
```ts
function redisRateLimiter(limiter: ReturnType<typeof rateLimit>) {
  return function rateLimitGate(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (redis.status !== 'ready') return next();
    limiter(req, res, next);
  };
}
```
(and `authRateLimitGate` likewise for `authRedisRateLimiter`, same bodies as today).

Verify at implementation time: `stripe.webhooks.constructEvent(payload, header, secret, tolerance)` signature and `generateTestHeaderString` options (`https://docs.stripe.com/webhooks.md#verify-events`).

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/webhooks.int.test.ts && npx jest && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing server/src/test/billing/webhookSign.ts server/src/app.ts
git commit -F - <<'MSG'
feat(billing): signed raw-body webhook receivers outside the rate limiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 6.5: Account and household deletion hooks (§5.11, §8.7, L6–L8)

**Files:**
- Create: `server/src/modules/billing/deletion.ts`
- Modify: `server/src/modules/auth/service.ts` (`finalizeUserDeletion`), `server/src/modules/household/service.ts` (`approveActionRequest`, `cancelHouseholdDeletion`, `finalizeHouseholdDeletion`, `transferAdmin`, `changeMemberRole`), their unit tests
- Test: `server/src/modules/billing/__int__/deletion.int.test.ts`

**Interfaces:**
- Consumes: `anonymizeUserLedger` (6.1), `upsertSubscription` (5.3), `notifyHouseholdAdmins`, `getAdminRecipients` (5.1), `raiseReviewItem` (5.1).
- Produces:
  - `onPurchaserDeleted(userId: string): Promise<void>`
  - `setCancelAtPeriodEndForHousehold(householdId: string, value: boolean, reason: string): Promise<string[]>` (Stripe subscriptions in allowed statuses, every mode with rows)
  - `onHouseholdDeletionScheduled(householdId: string): Promise<void>`, `onHouseholdDeletionCancelled(householdId: string): Promise<void>`, `onHouseholdPurged(householdId: string): Promise<void>`
  - `syncBillingEmail(householdId: string, excludeUserId?: string): Promise<void>` (per mode with a customer; DB first, then `customers.update`; the excluded user is the one being deleted)

- [ ] **Step 1: Write the failing integration test**

`server/src/modules/billing/__int__/deletion.int.test.ts`:
```ts
jest.mock('../notify', () => {
  const actual = jest.requireActual('../notify');
  return { ...actual, notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() };
});

import { setupAssociations, BillingSubscription, BillingTransaction, BillingCustomer, HouseholdMember, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription } from '../../../test/billing/fixtures';
import { onPurchaserDeleted, onHouseholdDeletionScheduled, onHouseholdDeletionCancelled, onHouseholdPurged, syncBillingEmail } from '../deletion';
import { notifyHouseholdAdmins } from '../notify';
import { ANONYMIZED_EMAIL } from '../ledger';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function paid() {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_Z' });
  const sub = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_Z', purchasedByUserId: admin.id });
  s.subscriptions.update.mockResolvedValue({});
  s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', cancelAtPeriodEnd: true }));
  s.customers.update.mockResolvedValue({});
  return { household, admin, sub };
}

describe('purchaser deletion (L6)', () => {
  it('cancels at period end, clears purchaser, anonymises ledger, notifies and moves the email', async () => {
    const { household, admin } = await paid();
    const newAdmin = await addMember(household.id);
    await HouseholdMember.update({ role: 'admin' }, { where: { userId: newAdmin.id } });
    await HouseholdMember.update({ role: 'member' }, { where: { userId: admin.id } });
    await BillingTransaction.create({ provider: 'stripe', livemode: false, type: 'payment', status: 'paid', amount: 899, currency: 'usd', matchStatus: 'matched', householdId: household.id, userId: admin.id, payerEmailSnapshot: admin.email, providerObjectId: 'in_Z', occurredAt: new Date() });

    await onPurchaserDeleted(admin.id);

    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_Z', { cancel_at_period_end: true }, { idempotencyKey: 'purchaser-deleted:sub_Z' });
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_Z' } })).toMatchObject({ purchasedByUserId: null, cancelAtPeriodEnd: true });
    expect(await BillingTransaction.findOne({ where: { providerObjectId: 'in_Z' } })).toMatchObject({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL });
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_purchaser_deleted', expect.any(String), expect.stringContaining('Resubscribe before'), expect.anything(), { email: true, excludeUserId: admin.id });
    expect(s.customers.update).toHaveBeenCalledWith('cus_Z', { email: newAdmin.email });
  });
});

describe('household deletion (L7, §8.7)', () => {
  it('scheduling sets cancel_at_period_end, cancelling reverses it', async () => {
    const { household } = await paid();
    await onHouseholdDeletionScheduled(household.id);
    expect(s.subscriptions.update).toHaveBeenLastCalledWith('sub_Z', { cancel_at_period_end: true }, expect.anything());
    await onHouseholdDeletionCancelled(household.id);
    expect(s.subscriptions.update).toHaveBeenLastCalledWith('sub_Z', { cancel_at_period_end: false }, expect.anything());
  });

  it('final purge cancels an allowed subscription immediately and audits it', async () => {
    const { household } = await paid();
    s.subscriptions.cancel.mockResolvedValue({});
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_Z', customer: 'cus_Z', status: 'canceled' }));
    await onHouseholdPurged(household.id);
    expect(s.subscriptions.cancel).toHaveBeenCalledWith('sub_Z', { prorate: false }, { idempotencyKey: `purge:${household.id}:sub_Z` });
    expect(await AdminAuditLog.count({ where: { path: `purge:household:${household.id}` } })).toBe(1);
  });
});

describe('admin transfer (L8)', () => {
  it('updates billing_email in the DB first, then Stripe', async () => {
    const { household } = await paid();
    const other = await addMember(household.id);
    await HouseholdMember.update({ role: 'member' }, { where: { householdId: household.id, role: 'admin' } });
    await HouseholdMember.update({ role: 'admin' }, { where: { userId: other.id } });
    await syncBillingEmail(household.id);
    expect((await BillingCustomer.findOne({ where: { providerCustomerId: 'cus_Z' } }))!.billingEmail).toBe(other.email);
    expect(s.customers.update).toHaveBeenCalledWith('cus_Z', { email: other.email });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/deletion.int.test.ts` → FAIL.

- [ ] **Step 3: Implement `deletion.ts`**

```ts
import { Op } from 'sequelize';
import { AdminAuditLog, BillingCustomer, BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getStripe, isModeAvailable } from './config';
import { clearEntitlementCache } from './entitlement';
import { anonymizeUserLedger } from './ledger';
import { modeFromLivemode } from './mode';
import { getAdminRecipients, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES } from './types';

const allowedWhere = { status: { [Op.in]: [...ALLOWED_STATUSES] } };

export async function syncBillingEmail(householdId: string, excludeUserId?: string): Promise<void> {
  const customers = await BillingCustomer.findAll({ where: { householdId, provider: 'stripe' } });
  if (customers.length === 0) return;
  const [admin] = await getAdminRecipients(householdId, excludeUserId);
  const email = admin?.email ?? null;
  for (const c of customers) {
    await c.update({ billingEmail: email });
    const mode = modeFromLivemode(c.livemode);
    if (!isModeAvailable(mode)) continue;
    try {
      // Verify at implementation time: clearing a customer email uses email: '' (https://docs.stripe.com/api/customers/update.md).
      await getStripe(mode).customers.update(c.providerCustomerId, { email: email ?? '' });
    } catch (err) {
      logger.warn(`[Billing] customers.update failed for ${c.providerCustomerId}; reconciliation will retry: ${(err as Error).message}`);
    }
  }
}

export async function setCancelAtPeriodEndForHousehold(householdId: string, value: boolean, reason: string): Promise<string[]> {
  const subs = await BillingSubscription.findAll({ where: { householdId, provider: 'stripe', ...allowedWhere } });
  const changed: string[] = [];
  for (const sub of subs) {
    if (sub.cancelAtPeriodEnd === value) continue;
    const mode = modeFromLivemode(sub.livemode);
    await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: value }, { idempotencyKey: `${reason}:${sub.providerSubscriptionId}:${value}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
    changed.push(sub.providerSubscriptionId);
  }
  return changed;
}

/** §5.11: runs from finalizeUserDeletion after the 30-day window. */
export async function onPurchaserDeleted(userId: string): Promise<void> {
  await anonymizeUserLedger(userId);
  const subs = await BillingSubscription.findAll({ where: { purchasedByUserId: userId } });
  for (const sub of subs) {
    const mode = modeFromLivemode(sub.livemode);
    const allowed = (ALLOWED_STATUSES as readonly string[]).includes(sub.status);
    if (allowed && sub.provider === 'stripe' && !sub.cancelAtPeriodEnd) {
      await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `purchaser-deleted:${sub.providerSubscriptionId}` });
    }
    await sub.update({ purchasedByUserId: null });
    if (sub.provider === 'stripe') await upsertSubscription(sub.providerSubscriptionId, mode);
    else await raiseReviewItem({ livemode: sub.livemode, kind: 'store_purchaser_deleted', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId });
    if (allowed) {
      const until = sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString().slice(0, 10) : 'the end of the current period';
      await notifyHouseholdAdmins(sub.householdId, 'billing_purchaser_deleted', 'Your Rootaroo subscription will end',
        `The member who paid for Rootaroo deleted their account, so the subscription will not renew. Resubscribe before ${until} to keep access.`,
        { type: 'billing_purchaser_deleted', until }, { email: true, excludeUserId: userId });
    }
    await syncBillingEmail(sub.householdId, userId);
    await clearEntitlementCache(sub.householdId);
  }
}

export async function onHouseholdDeletionScheduled(householdId: string): Promise<void> {
  await setCancelAtPeriodEndForHousehold(householdId, true, 'hh-delete');
}

export async function onHouseholdDeletionCancelled(householdId: string): Promise<void> {
  await setCancelAtPeriodEndForHousehold(householdId, false, 'hh-undelete');
}

export async function onHouseholdPurged(householdId: string): Promise<void> {
  const subs = await BillingSubscription.findAll({ where: { householdId, provider: 'stripe', ...allowedWhere } });
  for (const sub of subs) {
    const mode = modeFromLivemode(sub.livemode);
    await getStripe(mode).subscriptions.cancel(sub.providerSubscriptionId, { prorate: false }, { idempotencyKey: `purge:${householdId}:${sub.providerSubscriptionId}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
  }
  await AdminAuditLog.create({
    surface: 'billing-admin', keyLabel: 'system', method: 'JOB', path: `purge:household:${householdId}`,
    query: { canceled: subs.map((s) => s.providerSubscriptionId) }, bodyDigest: null, statusCode: 200, ip: null,
  });
}
```

- [ ] **Step 4: Wire the hooks**

`auth/service.ts` → `finalizeUserDeletion`, before `await user.destroy();`:
```ts
  // §5.11: ledger anonymisation, cancel-at-period-end for subscriptions they paid for.
  // Failure must not block account deletion; it is surfaced for staff review instead.
  await onPurchaserDeleted(user.id).catch(async (err) => {
    logger.error(`[Billing] purchaser deletion hook failed for ${user.id}:`, err);
    await raiseReviewItem({ livemode: false, kind: 'purchaser_deletion_failed', entityType: 'user', entityId: user.id, after: { error: (err as Error).message } }).catch(() => undefined);
  });
```
(imports: `onPurchaserDeleted` from `'../billing/deletion'`, `raiseReviewItem` from `'../billing/review'`, `logger` if absent).

`household/service.ts`:
- `approveActionRequest`: declare `let scheduledHouseholdId: string | null = null;` before the transaction, set `scheduledHouseholdId = request.householdId;` in the `delete` branch, change `return await sequelize.transaction(...)` to `const result = await sequelize.transaction(...)`, then after it:
```ts
  if (scheduledHouseholdId) {
    void onHouseholdDeletionScheduled(scheduledHouseholdId).catch((err) => logger.error('[Billing] deletion-scheduled hook failed:', err));
  }
  return result;
```
- `cancelHouseholdDeletion`: after `await household.save();` add `void onHouseholdDeletionCancelled(householdId).catch((err) => logger.error('[Billing] deletion-cancelled hook failed:', err));`
- `finalizeHouseholdDeletion`: first line `await onHouseholdPurged(household.id);` (a failure aborts this household's purge for this run and the hourly job retries it).
- `transferAdmin` and `changeMemberRole`: after the role updates, `void syncBillingEmail(householdId).catch(() => undefined);`

In `household.service.test.ts` add:
```ts
jest.mock('../../billing/deletion', () => ({
  onHouseholdDeletionScheduled: jest.fn().mockResolvedValue(undefined),
  onHouseholdDeletionCancelled: jest.fn().mockResolvedValue(undefined),
  onHouseholdPurged: jest.fn().mockResolvedValue(undefined),
  syncBillingEmail: jest.fn().mockResolvedValue(undefined),
}));
import { onHouseholdDeletionScheduled, onHouseholdDeletionCancelled, syncBillingEmail } from '../../billing/deletion';
```
and in the existing `approveActionRequest` delete-approval test add `expect(onHouseholdDeletionScheduled).toHaveBeenCalledWith(householdId);`; in the `cancelHouseholdDeletion` success test `expect(onHouseholdDeletionCancelled).toHaveBeenCalledWith(householdId);`; in the `transferAdmin` success test `expect(syncBillingEmail).toHaveBeenCalledWith(householdId);`.

In `auth.service.test.ts` add `jest.mock('../../billing/deletion', () => ({ onPurchaserDeleted: jest.fn().mockResolvedValue(undefined) }));` and `jest.mock('../../billing/review', () => ({ raiseReviewItem: jest.fn().mockResolvedValue(undefined) }));`, and in its confirm-deletion success test assert `expect(onPurchaserDeleted).toHaveBeenCalledWith(<that test's user id>)`.

- [ ] **Step 5: Run to verify it passes**

```bash
cd server && npm run test:int -- src/modules/billing/__int__/deletion.int.test.ts
cd server && npx jest src/modules/household src/modules/auth && npm run type-check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules
git commit -F - <<'MSG'
feat(billing): billing hooks for purchaser deletion, household deletion and admin transfer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 6 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && npx jest --coverage --collectCoverageFrom='src/modules/billing/**/*.ts' --collectCoverageFrom='!src/modules/billing/scripts/**' src/modules/billing
```
Live check (orchestrator): with `npm run dev` running and
`stripe listen --api-key "$STRIPE_TEST_SECRET_KEY" --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test` (its printed signing secret placed in `STRIPE_TEST_WEBHOOK_SECRETS` and the server restarted), run `stripe trigger customer.updated --api-key "$STRIPE_TEST_SECRET_KEY"`.
Acceptance:
- All green versus baseline; unit coverage of `modules/billing` (unit suite alone) ≥ 80% now (≥ 90% is required at W8).
- The triggered event appears in `billing_events` as `processed` or `ignored` within 5 s; the listener shows `200`.
- Evidence: `docs/superpowers/evidence/w6-webhooks.md` with the listener output and the DB row (no secrets).

---
## Wave 7: Reconciliation, sweeps, price notices and alerting (§10, §6.4)

### Task 7.1: Checkout sweep (§10, T2, T3, T6)

**Files:**
- Create: `server/src/modules/billing/checkoutSweep.ts`, `server/src/jobs/billing-checkout-sweep.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/modules/billing/__int__/checkoutSweep.int.test.ts`

**Interfaces:**
- Produces: `CHECKOUT_SWEEP_AGE_MS = 5 * 60_000`; `sweepCheckouts(mode: BillingMode, now?: Date): Promise<{ completed: number; expired: number; failed: number }>`; `startBillingCheckoutSweepJob(): void` (every 15 min per available mode, lock `billing:job:checkout-sweep:{mode}`).

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__int__/checkoutSweep.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import { v4 as uuidv4 } from 'uuid';
import { setupAssociations, BillingCheckoutSession, BillingSubscription } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { sweepCheckouts } from '../checkoutSweep';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

async function row(householdId: string, userId: string, o: Record<string, unknown>) {
  return BillingCheckoutSession.create({
    id: uuidv4(), householdId, livemode: false, createdByUserId: userId, interval: 'month', seats: 5,
    status: 'open', url: 'u', expiresAt: new Date(Date.now() + 1e6), ...o,
  });
}

describe('sweepCheckouts', () => {
  it('syncs completed sessions, marks expired, fails orphaned creating rows, ignores fresh rows', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
    const old = new Date(Date.now() - 10 * 60_000);
    const done = await row(household.id, admin.id, { providerSessionId: 'cs_test_done', createdAt: old });
    const gone = await row(household.id, admin.id, { providerSessionId: 'cs_test_gone', createdAt: old });
    const orphan = await row(household.id, admin.id, { status: 'creating', providerSessionId: null, createdAt: old });
    const fresh = await row(household.id, admin.id, { providerSessionId: 'cs_test_fresh' });
    s.checkout.sessions.retrieve.mockImplementation(async (id: string) =>
      id === 'cs_test_done'
        ? stripeCheckoutSession({ id, status: 'complete', subscription: 'sub_1', customer: 'cus_1' })
        : stripeCheckoutSession({ id, status: 'expired' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));

    expect(await sweepCheckouts('test')).toEqual({ completed: 1, expired: 1, failed: 1 });
    expect((await done.reload()).status).toBe('complete');
    expect((await gone.reload()).status).toBe('expired');
    expect((await orphan.reload()).status).toBe('failed');
    expect((await fresh.reload()).status).toBe('open');
    expect(await BillingSubscription.count({ where: { providerSubscriptionId: 'sub_1' } })).toBe(1);
  });
});
```
(`createdAt` is settable on create because the model declares it; if Sequelize overrides it, set it afterwards with `BillingCheckoutSession.update({ createdAt: old }, { where: { id }, silent: true })`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/checkoutSweep.int.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`checkoutSweep.ts`:
```ts
import { Op } from 'sequelize';
import { BillingCheckoutSession } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getStripe } from './config';
import { livemodeOf } from './mode';
import { idOf, upsertSubscription } from './sync';
import type { BillingMode } from './types';

export const CHECKOUT_SWEEP_AGE_MS = 5 * 60_000;

export async function sweepCheckouts(mode: BillingMode, now: Date = new Date()): Promise<{ completed: number; expired: number; failed: number }> {
  const stripe = getStripe(mode);
  const rows = await BillingCheckoutSession.findAll({
    where: { livemode: livemodeOf(mode), status: { [Op.in]: ['open', 'creating'] }, createdAt: { [Op.lte]: new Date(now.getTime() - CHECKOUT_SWEEP_AGE_MS) } },
  });
  const out = { completed: 0, expired: 0, failed: 0 };
  for (const row of rows) {
    if (!row.providerSessionId) {
      await row.update({ status: 'failed' });
      out.failed++;
      continue;
    }
    try {
      const session = await stripe.checkout.sessions.retrieve(row.providerSessionId);
      if (session.status === 'complete') {
        await row.update({ status: 'complete' });
        const subId = idOf(session.subscription as string | { id: string } | null);
        if (subId) await upsertSubscription(subId, mode);
        out.completed++;
      } else if (session.status === 'expired') {
        await row.update({ status: 'expired' });
        out.expired++;
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') {
        await row.update({ status: 'failed' });
        out.failed++;
      } else {
        logger.warn(`[Billing] checkout sweep could not fetch ${row.providerSessionId}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}
```

`server/src/jobs/billing-checkout-sweep.ts`:
```ts
import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { sweepCheckouts } from '../modules/billing/checkoutSweep';
import { withLock } from '../modules/billing/locks';
import { LockBusyError } from '../modules/billing/errors';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

export function startBillingCheckoutSweepJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    for (const mode of ['test', 'live'] as BillingMode[]) {
      if (!isModeAvailable(mode)) continue;
      try {
        const r = await withLock(`billing:job:checkout-sweep:${mode}`, 10 * 60_000, () => sweepCheckouts(mode));
        if (r.completed || r.expired || r.failed) logger.info(`[Checkout Sweep] ${mode} ${JSON.stringify(r)}`);
      } catch (err) {
        if (!(err instanceof LockBusyError)) logger.error(`[Checkout Sweep] ${mode} failed:`, err);
      }
    }
  });
  logger.info('[Checkout Sweep] Cron job registered — runs every 15 minutes');
}
```
`index.ts`: register `startBillingCheckoutSweepJob();`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/checkoutSweep.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing server/src/jobs/billing-checkout-sweep.ts server/src/index.ts
git commit -F - <<'MSG'
feat(billing): 15-minute checkout sweep for abandoned and missed sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 7.2: Reconciliation runs (§10 daily/weekly/manual, criterion 5)

**Files:**
- Create: `server/src/modules/billing/reconcile.ts`
- Modify: `server/src/modules/billing/scripts/stripe-bootstrap.ts` (`--backfill`)
- Test: `server/src/modules/billing/__tests__/reconcile.test.ts`, `server/src/modules/billing/__int__/reconcile.int.test.ts`

**Interfaces:**
- Consumes: `upsertSubscription` (5.3); `recordInvoice`, `recordRefund`, `recordDispute`, `fetchPaymentFees` (6.1); `envOfEventObject` (6.2); `sweepCheckouts` (7.1); `syncBillingEmail` (6.5); `getAdminRecipients`, `raiseReviewItem`, `recordAutoFix` (5.1).
- Produces:
  - `type ReconKind = 'daily' | 'weekly' | 'manual'`
  - `interface ReconCounts { subscriptionsChecked: number; subscriptionsFixed: number; missingInStripe: number; ledgerUpserts: number; feesFilled: number; emailDriftFixed: number; checkoutRowsFixed: number; reviewItems: number }`
  - `SUB_FIELDS` (compared fields), `snapshotSub(row: BillingSubscription): Record<string, unknown>`, `diffSnapshots(a, b): string[]` (pure)
  - `runReconciliation(mode: BillingMode, kind: ReconKind, now?: Date): Promise<BillingReconciliationRun>`

Classification (spec §10): auto-fixed = subscription field drift, missing ledger row / fee / refund or dispute status, stale checkout rows, billing email drift; needs review = unmatched objects (raised by upsert/ledger), unresolved duplicates, local subscription missing in Stripe (also marked `canceled`), amount still differing after a write, dead events (raised by the sweep).

- [ ] **Step 1: Write the failing unit test**

`server/src/modules/billing/__tests__/reconcile.test.ts`:
```ts
import { snapshotSub, diffSnapshots } from '../reconcile';

const row = (o: Record<string, unknown> = {}) => ({
  status: 'active', seats: 5, interval: 'month', priceId: 'p1', unitAmount: 899, currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  cancelAtPeriodEnd: false, pendingUpdate: null, graceUntil: null, ...o,
}) as any;

describe('reconciliation classification', () => {
  it('snapshots comparable fields with ISO dates', () => {
    expect(snapshotSub(row())).toMatchObject({ currentPeriodEnd: '2026-11-01T00:00:00.000Z', pendingUpdate: null });
  });

  it('reports exactly the drifted fields', () => {
    expect(diffSnapshots(snapshotSub(row()), snapshotSub(row({ seats: 7, cancelAtPeriodEnd: true })))).toEqual(['seats', 'cancelAtPeriodEnd']);
    expect(diffSnapshots(snapshotSub(row({ pendingUpdate: { a: 1 } })), snapshotSub(row({ pendingUpdate: { a: 1 } })))).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing integration test (planted mismatches)**

`server/src/modules/billing/__int__/reconcile.int.test.ts`:
```ts
jest.mock('../notify', () => {
  const actual = jest.requireActual('../notify');
  return { ...actual, notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() };
});

import {
  setupAssociations, BillingSubscription, BillingReconciliationItem, BillingTransaction, BillingCustomer,
} from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { stripeSubscription, stripeInvoice } from '../../../test/billing/fixtures';
import { runReconciliation } from '../reconcile';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test'); });
afterAll(() => closeIntResources());

describe('runReconciliation (criterion 5)', () => {
  it('fixes planted drift, fills ledger and fees, flags what needs review', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_R', billingEmail: 'stale@x' });
    // planted: wrong seats/status locally
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_R', seats: 5, status: 'past_due', purchasedByUserId: admin.id });
    // planted: local subscription Stripe no longer knows
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_GONE', status: 'active' });
    // planted: payment row with missing fee
    await BillingTransaction.create({ provider: 'stripe', livemode: false, type: 'payment', status: 'paid', amount: 899, currency: 'usd', matchStatus: 'matched', householdId: household.id, providerObjectId: 'in_NOFEE', occurredAt: new Date() });

    s.subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === 'sub_GONE') throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      return stripeSubscription({ id, customer: 'cus_R', seats: 8, status: 'active' });
    });
    s.subscriptions.list.mockReturnValue(listOf([stripeSubscription({ id: 'sub_R', customer: 'cus_R', seats: 8 }), stripeSubscription({ id: 'sub_OTHER_ENV', env: 'prod' })]));
    s.invoices.list.mockReturnValue(listOf([stripeInvoice({ id: 'in_MISSING', customer: 'cus_R', subscriptionId: 'sub_R', amountPaid: 1496 })]));
    s.invoicePayments.list.mockReturnValue(listOf([{ status: 'paid', payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } } }]));
    s.charges.retrieve.mockResolvedValue({ id: 'ch_1', receipt_url: null, balance_transaction: { fee: 73, net: 1423 } });
    s.customers.retrieve.mockResolvedValue({ id: 'cus_R', email: 'stale@x' });
    s.customers.update.mockResolvedValue({});

    const run = await runReconciliation('test', 'daily');

    expect(run.status).toBe('succeeded');
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_R' } })).toMatchObject({ seats: 8, status: 'active' });
    const drift = await BillingReconciliationItem.findOne({ where: { kind: 'subscription_drift', providerObjectId: 'sub_R' } });
    expect(drift).toMatchObject({ resolution: 'auto_fixed', runId: run.id });
    expect(drift!.before).toMatchObject({ seats: 5, status: 'past_due' });
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_GONE' } })).toMatchObject({ status: 'canceled' });
    expect(await BillingReconciliationItem.count({ where: { kind: 'missing_in_stripe', resolution: 'needs_review' } })).toBe(1);
    expect(await BillingTransaction.findOne({ where: { providerObjectId: 'in_MISSING' } })).toMatchObject({ amount: 1496, fee: 73 });
    expect((await BillingTransaction.findOne({ where: { providerObjectId: 'in_NOFEE' } }))!.fee).toBe(73);
    expect((await BillingCustomer.findOne({ where: { providerCustomerId: 'cus_R' } }))!.billingEmail).toBe(admin.email);
    expect(s.customers.update).toHaveBeenCalledWith('cus_R', { email: admin.email });
    expect(s.subscriptions.retrieve).not.toHaveBeenCalledWith('sub_OTHER_ENV', expect.anything());
    expect(run.counts).toMatchObject({ subscriptionsFixed: 1, missingInStripe: 1, feesFilled: 1, emailDriftFixed: 1 });
  });

  it('flags duplicates that §8.6 could not resolve (cross-provider)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_A' });
    await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000555' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_A', householdId: household.id }));
    await runReconciliation('test', 'manual');
    expect(await BillingReconciliationItem.count({ where: { kind: 'unresolved_duplicate' } })).toBe(1);
  });

  it('weekly lists every subscription (no created filter) and a 35-day ledger window', async () => {
    await runReconciliation('test', 'weekly', new Date('2026-10-10T04:00:00Z'));
    expect(s.subscriptions.list).toHaveBeenCalledWith({ status: 'all', limit: 100 });
    const since = Math.floor(new Date('2026-09-05T04:00:00Z').getTime() / 1000);
    expect(s.invoices.list).toHaveBeenCalledWith({ created: { gte: since }, limit: 100 });
  });

  it('marks the run failed when Stripe errors', async () => {
    s.subscriptions.list.mockImplementation(() => { throw new Error('api down'); });
    await expect(runReconciliation('test', 'daily')).rejects.toThrow('api down');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/reconcile.test.ts` → FAIL.

- [ ] **Step 4: Implement `reconcile.ts`**

```ts
import Stripe from 'stripe';
import { Op } from 'sequelize';
import {
  BillingCustomer, BillingReconciliationItem, BillingReconciliationRun, BillingSubscription, BillingTransaction,
} from '../../database/models';
import { getBillingConfig, getStripe } from './config';
import { sweepCheckouts } from './checkoutSweep';
import { syncBillingEmail } from './deletion';
import { clearEntitlementCache } from './entitlement';
import { envOfEventObject } from './handlers';
import { fetchPaymentFees, recordDispute, recordInvoice, recordRefund } from './ledger';
import { livemodeOf } from './mode';
import { getAdminRecipients } from './notify';
import { raiseReviewItem, recordAutoFix } from './review';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES, BillingMode } from './types';

export type ReconKind = 'daily' | 'weekly' | 'manual';
export interface ReconCounts {
  subscriptionsChecked: number; subscriptionsFixed: number; missingInStripe: number; ledgerUpserts: number;
  feesFilled: number; emailDriftFixed: number; checkoutRowsFixed: number; reviewItems: number;
}

export const SUB_FIELDS = ['status', 'seats', 'interval', 'priceId', 'unitAmount', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'pendingUpdate', 'graceUntil'] as const;

export function snapshotSub(row: BillingSubscription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SUB_FIELDS) {
    const v = (row as unknown as Record<string, unknown>)[f];
    out[f] = v instanceof Date ? v.toISOString() : v === undefined ? null : v;
  }
  return out;
}

export function diffSnapshots(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return SUB_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export async function runReconciliation(mode: BillingMode, kind: ReconKind, now: Date = new Date()): Promise<BillingReconciliationRun> {
  const livemode = livemodeOf(mode);
  const stripe = getStripe(mode);
  const envTag = getBillingConfig().envTag;
  const envOk = (obj: unknown) => { const e = envOfEventObject(obj); return !e || e === envTag; };
  const run = await BillingReconciliationRun.create({ livemode, kind, startedAt: now, status: 'running' });
  const counts: ReconCounts = { subscriptionsChecked: 0, subscriptionsFixed: 0, missingInStripe: 0, ledgerUpserts: 0, feesFilled: 0, emailDriftFixed: 0, checkoutRowsFixed: 0, reviewItems: 0 };
  const since = Math.floor((now.getTime() - (kind === 'weekly' ? 35 : 2) * 86400_000) / 1000);

  try {
    // (a)+(b) collect subscriptions to re-fetch
    const subIds = new Set<string>();
    const localAllowed = await BillingSubscription.findAll({ where: { livemode, provider: 'stripe', status: { [Op.in]: [...ALLOWED_STATUSES] } } });
    localAllowed.forEach((r) => subIds.add(r.providerSubscriptionId));
    const listParams: Stripe.SubscriptionListParams = kind === 'weekly' ? { status: 'all', limit: 100 } : { status: 'all', limit: 100, created: { gte: since } };
    for await (const sub of stripe.subscriptions.list(listParams)) if (envOk(sub)) subIds.add(sub.id);
    if (kind !== 'weekly') {
      const recent = await BillingTransaction.findAll({ where: { livemode, provider: 'stripe', occurredAt: { [Op.gte]: new Date(since * 1000) }, subscriptionId: { [Op.ne]: null } }, attributes: ['subscriptionId'] });
      const rows = await BillingSubscription.findAll({ where: { id: [...new Set(recent.map((t) => t.subscriptionId!))] }, attributes: ['providerSubscriptionId'] });
      rows.forEach((r) => subIds.add(r.providerSubscriptionId));
    }

    for (const subId of subIds) {
      const local = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
      const before = local ? snapshotSub(local) : null;
      try {
        const row = await upsertSubscription(subId, mode);
        counts.subscriptionsChecked++;
        if (before && row) {
          const changed = diffSnapshots(before, snapshotSub(row));
          if (changed.length > 0) {
            await recordAutoFix({ livemode, kind: 'subscription_drift', entityType: 'subscription', entityId: row.id, providerObjectId: subId, before: pick(before, changed), after: pick(snapshotSub(row), changed), runId: run.id });
            counts.subscriptionsFixed++;
          }
        }
      } catch (err) {
        if ((err as { code?: string }).code !== 'resource_missing' || !local) throw err;
        await local.update({ status: 'canceled', graceUntil: null, endedAt: local.endedAt ?? now });
        await clearEntitlementCache(local.householdId);
        await raiseReviewItem({ livemode, kind: 'missing_in_stripe', entityType: 'subscription', entityId: local.id, providerObjectId: subId, before, runId: run.id });
        counts.missingInStripe++;
      }
    }

    // (c) ledger
    for await (const inv of stripe.invoices.list({ created: { gte: since }, limit: 100 })) {
      if (!envOk(inv)) continue;
      if (inv.status === 'paid') {
        const row = await recordInvoice(inv, mode, 'payment', null);
        counts.ledgerUpserts++;
        if (row.amount !== inv.amount_paid) {
          await raiseReviewItem({ livemode, kind: 'amount_mismatch', entityType: 'invoice', providerObjectId: inv.id!, before: { ledger: row.amount }, after: { stripe: inv.amount_paid }, runId: run.id });
        }
      } else if (inv.status === 'open' && inv.attempted) {
        await recordInvoice(inv, mode, 'failed_payment', null);
        counts.ledgerUpserts++;
      }
    }
    for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100 })) {
      await recordRefund(refund, mode, null);
      counts.ledgerUpserts++;
    }
    for await (const dispute of stripe.disputes.list({ created: { gte: since }, limit: 100 })) {
      await recordDispute(dispute, mode, null);
      counts.ledgerUpserts++;
    }

    // (d) missing fees
    const noFee = await BillingTransaction.findAll({ where: { livemode, provider: 'stripe', type: 'payment', fee: null }, limit: 500 });
    for (const t of noFee) {
      const fees = await fetchPaymentFees(t.providerObjectId, mode);
      if (fees && fees.fee !== null) {
        await t.update({ fee: fees.fee, net: fees.net, providerChargeId: fees.chargeId, receiptUrl: fees.receiptUrl ?? t.receiptUrl });
        counts.feesFilled++;
      }
    }

    // (e) billing email drift (§5.11 retry path)
    for (const c of await BillingCustomer.findAll({ where: { livemode, provider: 'stripe' } })) {
      const [admin] = await getAdminRecipients(c.householdId);
      const expected = admin?.email ?? null;
      const remote = await stripe.customers.retrieve(c.providerCustomerId);
      if ((remote as Stripe.DeletedCustomer).deleted) continue;
      const remoteEmail = (remote as Stripe.Customer).email ?? null;
      if (remoteEmail !== expected || c.billingEmail !== expected) {
        await syncBillingEmail(c.householdId);
        await recordAutoFix({ livemode, kind: 'email_drift', entityType: 'customer', entityId: c.id, providerObjectId: c.providerCustomerId, before: { stripe: remoteEmail, local: c.billingEmail }, after: { email: expected }, runId: run.id });
        counts.emailDriftFixed++;
      }
    }

    // stale checkout rows
    const sweep = await sweepCheckouts(mode, now);
    counts.checkoutRowsFixed = sweep.completed + sweep.expired + sweep.failed;

    // duplicates §8.6 could not resolve
    const allowedNow = await BillingSubscription.findAll({ where: { livemode, status: { [Op.in]: [...ALLOWED_STATUSES] } }, attributes: ['householdId', 'providerSubscriptionId'] });
    const byHousehold = new Map<string, string[]>();
    for (const r of allowedNow) byHousehold.set(r.householdId, [...(byHousehold.get(r.householdId) ?? []), r.providerSubscriptionId]);
    for (const [householdId, ids] of byHousehold) {
      if (ids.length > 1) await raiseReviewItem({ livemode, kind: 'unresolved_duplicate', entityType: 'household', entityId: householdId, providerObjectId: ids.sort().join(','), runId: run.id });
    }

    counts.reviewItems = await BillingReconciliationItem.count({ where: { livemode, resolution: 'needs_review', createdAt: { [Op.gte]: now } } });
    await run.update({ status: 'succeeded', finishedAt: new Date(), counts: { ...counts } });
    return run;
  } catch (err) {
    await run.update({ status: 'failed', finishedAt: new Date(), counts: { ...counts } });
    throw err;
  }
}
```

- [ ] **Step 5: Add `--backfill` to the bootstrap**

In `stripe-bootstrap.ts` `main`, after parsing and before products (so `--backfill` can run alone):
```ts
  if (opts.backfill) {
    const { setupAssociations } = await import('../../../database/models');
    const { runReconciliation } = await import('../reconcile');
    setupAssociations();
    const run = await runReconciliation(opts.mode, 'weekly');
    console.log(`backfill (weekly reconciliation) ${run.id}: ${run.status} ${JSON.stringify(run.counts)}`);
    return;
  }
```
`--backfill` uses the runtime config (`getStripe`), so it runs where the server's env is loaded (locally with `server/.env`, in production via `railway run`).

- [ ] **Step 6: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/reconcile.test.ts && npm run test:int -- src/modules/billing/__int__/reconcile.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing): daily, weekly and manual reconciliation with auto-fix and review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 7.3: Reconciliation jobs and alerting (§10 alerting)

**Files:**
- Create: `server/src/modules/billing/alerts.ts`, `server/src/jobs/billing-reconcile.ts`
- Modify: `server/src/jobs/billing-event-sweep.ts`, `server/src/index.ts`
- Test: `server/src/modules/billing/__int__/alerts.int.test.ts`

**Interfaces:**
- Produces:
  - `RUN_SLOW_MS = 30 * 60_000`, `FAILED_BURST_THRESHOLD = 5`, `FAILED_BURST_WINDOW_MS = 15 * 60_000`
  - `alertOnRun(run: BillingReconciliationRun): Promise<void>` (failed or > 30 min → alert; new review items → one summary email)
  - `maybeAlertFailedBurst(now?: Date): Promise<boolean>` (≥ 5 failed in 15 min; throttled to once per window)
  - `alertStuckRuns(now?: Date): Promise<number>` (running > 30 min)
  - `runReconciliationLocked(mode: BillingMode, kind: ReconKind): Promise<BillingReconciliationRun>` (lock `billing:job:reconcile-{kind}:{mode}`, 40 min TTL, then `alertOnRun`)
  - `startBillingReconcileJobs(): void` (daily `30 3 * * *` UTC, weekly `0 4 * * 0` UTC, per available mode)
  - `__resetAlertThrottleForTests(): void`

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__int__/alerts.int.test.ts`:
```ts
jest.mock('../notify', () => ({ alertStaff: jest.fn(), notifyHouseholdAdmins: jest.fn(), getAdminRecipients: jest.fn(async () => []) }));

import { setupAssociations, BillingEvent, BillingReconciliationRun, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { alertOnRun, maybeAlertFailedBurst, alertStuckRuns, __resetAlertThrottleForTests } from '../alerts';
import { alertStaff } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); __resetAlertThrottleForTests(); (alertStaff as jest.Mock).mockClear(); });
afterAll(() => closeIntResources());

describe('alerting', () => {
  it('alerts on failed and slow runs, and summarises new review items in one email', async () => {
    const start = new Date(Date.now() - 31 * 60_000);
    const slow = await BillingReconciliationRun.create({ livemode: false, kind: 'daily', startedAt: start, finishedAt: new Date(), status: 'succeeded', counts: {} });
    await BillingReconciliationItem.create({ livemode: false, kind: 'missing_in_stripe', entityType: 'subscription', resolution: 'needs_review', runId: slow.id });
    await BillingReconciliationItem.create({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', resolution: 'needs_review' });
    await alertOnRun(slow);
    const subjects = (alertStaff as jest.Mock).mock.calls.map((c) => c[0]);
    expect(subjects).toEqual(expect.arrayContaining([expect.stringMatching(/took/), expect.stringMatching(/2 new review items/)]));
    (alertStaff as jest.Mock).mockClear();
    await alertOnRun(await BillingReconciliationRun.create({ livemode: false, kind: 'daily', startedAt: new Date(), finishedAt: new Date(), status: 'failed', counts: {} }));
    expect((alertStaff as jest.Mock).mock.calls[0][0]).toMatch(/failed/);
  });

  it('alerts once per window on 5+ failed events in 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: `evt_f${i}`, type: 'invoice.paid', payload: {}, status: 'failed', attempts: 1, receivedAt: new Date() });
    }
    expect(await maybeAlertFailedBurst()).toBe(true);
    expect(await maybeAlertFailedBurst()).toBe(false);
    expect(alertStaff).toHaveBeenCalledTimes(1);
  });

  it('does not alert below the threshold', async () => {
    await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: 'evt_one', type: 'x', payload: {}, status: 'failed', receivedAt: new Date() });
    expect(await maybeAlertFailedBurst()).toBe(false);
  });

  it('alerts on runs stuck in running for more than 30 minutes', async () => {
    await BillingReconciliationRun.create({ livemode: false, kind: 'weekly', startedAt: new Date(Date.now() - 40 * 60_000), status: 'running' });
    expect(await alertStuckRuns()).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/alerts.int.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`alerts.ts`:
```ts
import { Op } from 'sequelize';
import { BillingEvent, BillingReconciliationItem, BillingReconciliationRun } from '../../database/models';
import { withLock } from './locks';
import { alertStaff } from './notify';
import { ReconKind, runReconciliation } from './reconcile';
import type { BillingMode } from './types';

export const RUN_SLOW_MS = 30 * 60_000;
export const FAILED_BURST_THRESHOLD = 5;
export const FAILED_BURST_WINDOW_MS = 15 * 60_000;

let lastBurstAlertAt = 0;
export function __resetAlertThrottleForTests(): void { lastBurstAlertAt = 0; }

export async function alertOnRun(run: BillingReconciliationRun): Promise<void> {
  const label = `${run.kind} reconciliation (${run.livemode ? 'live' : 'test'})`;
  const duration = (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime();
  if (run.status === 'failed') await alertStaff(`${label} failed`, `Run ${run.id} failed after ${Math.round(duration / 1000)} s. Counts: ${JSON.stringify(run.counts)}`);
  else if (duration > RUN_SLOW_MS) await alertStaff(`${label} took ${Math.round(duration / 60_000)} minutes`, `Run ${run.id} exceeded 30 minutes.`);

  const items = await BillingReconciliationItem.findAll({
    where: { livemode: run.livemode, resolution: 'needs_review', createdAt: { [Op.gte]: run.startedAt } },
    order: [['createdAt', 'ASC']],
  });
  if (items.length > 0) {
    await alertStaff(`${items.length} new review items after ${label}`,
      items.map((i) => `- ${i.kind} ${i.entityType} ${i.providerObjectId ?? i.entityId ?? ''}`).join('\n'));
  }
}

export async function maybeAlertFailedBurst(now: Date = new Date()): Promise<boolean> {
  if (now.getTime() - lastBurstAlertAt < FAILED_BURST_WINDOW_MS) return false;
  const failed = await BillingEvent.count({ where: { status: 'failed', updatedAt: { [Op.gte]: new Date(now.getTime() - FAILED_BURST_WINDOW_MS) } } });
  if (failed < FAILED_BURST_THRESHOLD) return false;
  lastBurstAlertAt = now.getTime();
  await alertStaff(`${failed} webhook events failed in 15 minutes`, 'Check billing_events where status = failed, and the server logs.');
  return true;
}

export async function alertStuckRuns(now: Date = new Date()): Promise<number> {
  const stuck = await BillingReconciliationRun.findAll({ where: { status: 'running', startedAt: { [Op.lt]: new Date(now.getTime() - RUN_SLOW_MS) } } });
  for (const run of stuck) await alertStaff(`Reconciliation ${run.kind} still running after 30 minutes`, `Run ${run.id} started ${run.startedAt.toISOString()}.`);
  return stuck.length;
}

export async function runReconciliationLocked(mode: BillingMode, kind: ReconKind): Promise<BillingReconciliationRun> {
  return withLock(`billing:job:reconcile-${kind}:${mode}`, 40 * 60_000, async () => {
    try {
      const run = await runReconciliation(mode, kind);
      await alertOnRun(run);
      return run;
    } catch (err) {
      const failed = await BillingReconciliationRun.findOne({ where: { kind, status: 'failed' }, order: [['createdAt', 'DESC']] });
      if (failed) await alertOnRun(failed);
      throw err;
    }
  });
}
```
(The burst throttle is in-process; with several instances each may send one alert per window, which is acceptable.)

`server/src/jobs/billing-reconcile.ts`:
```ts
import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { alertStuckRuns, runReconciliationLocked } from '../modules/billing/alerts';
import { LockBusyError } from '../modules/billing/errors';
import type { ReconKind } from '../modules/billing/reconcile';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

async function runAll(kind: ReconKind): Promise<void> {
  await alertStuckRuns().catch(() => 0);
  for (const mode of ['test', 'live'] as BillingMode[]) {
    if (!isModeAvailable(mode)) continue;
    try {
      const run = await runReconciliationLocked(mode, kind);
      logger.info(`[Reconcile] ${kind} ${mode}: ${run.status} ${JSON.stringify(run.counts)}`);
    } catch (err) {
      if (!(err instanceof LockBusyError)) logger.error(`[Reconcile] ${kind} ${mode} failed:`, err);
    }
  }
}

export function startBillingReconcileJobs(): void {
  cron.schedule('30 3 * * *', () => { void runAll('daily'); }, { timezone: 'UTC' });
  cron.schedule('0 4 * * 0', () => { void runAll('weekly'); }, { timezone: 'UTC' });
  logger.info('[Reconcile] Cron jobs registered — daily 03:30 UTC, weekly Sunday 04:00 UTC');
}
```
`billing-event-sweep.ts`: after the sweep result line, inside the `try`, add `await maybeAlertFailedBurst();` (import from `../modules/billing/alerts`). `index.ts`: register `startBillingReconcileJobs();`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/alerts.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing/alerts.ts server/src/modules/billing/__int__/alerts.int.test.ts server/src/jobs server/src/index.ts
git commit -F - <<'MSG'
feat(billing): scheduled reconciliation and staff alerting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 7.4: Price migrations and notices (§6.4)

**Files:**
- Create: `server/src/modules/billing/priceNotices.ts`, `server/src/jobs/billing-price-notices.ts`
- Modify: `server/src/modules/billing/scripts/stripe-bootstrap.ts` (`--migrate-prices`), `server/src/index.ts`
- Test: `server/src/modules/billing/__tests__/priceNotices.test.ts`, `server/src/modules/billing/__int__/priceNotices.int.test.ts`

**Interfaces:**
- Produces:
  - `RENEWAL_GUARD_MS = 48 * 3600_000`
  - `noticeDecision(notice: { applyAfter: Date }, sub: { status: SubscriptionStatus; currentPeriodEnd: Date | null; endedAt: Date | null }, now: Date): 'apply' | 'wait' | 'skip'` (pure)
  - `effectiveRenewalDate(applyAfter: Date, currentPeriodEnd: Date, interval: BillingInterval): Date` (pure)
  - `scheduleMigration(mode: BillingMode, from: string, to: string, noticeDays: number, now?: Date): Promise<{ scheduled: number; skipped: number }>`
  - `applyDueNotices(mode: BillingMode, now?: Date): Promise<{ applied: number; skipped: number; failed: number; waiting: number }>`
  - `startBillingPriceNoticesJob(): void` (daily 05:00 UTC, lock `billing:job:price-notices:{mode}`)

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/priceNotices.test.ts`:
```ts
import { noticeDecision, effectiveRenewalDate } from '../priceNotices';

const day = 86400_000;
const NOW = new Date('2026-11-10T00:00:00Z');
const sub = (o: Record<string, unknown> = {}) => ({ status: 'active', currentPeriodEnd: new Date(NOW.getTime() + 10 * day), endedAt: null, ...o }) as any;

describe('noticeDecision (§6.4)', () => {
  it('waits until apply_after', () => expect(noticeDecision({ applyAfter: new Date(NOW.getTime() + day) }, sub(), NOW)).toBe('wait'));
  it('applies when due and more than 48 h before renewal', () => expect(noticeDecision({ applyAfter: NOW }, sub(), NOW)).toBe('apply'));
  it('rolls over inside the 48 h window', () => {
    expect(noticeDecision({ applyAfter: NOW }, sub({ currentPeriodEnd: new Date(NOW.getTime() + 47 * 3600_000) }), NOW)).toBe('wait');
  });
  it.each(['canceled', 'unpaid', 'incomplete_expired'])('skips %s subscriptions', (status) => {
    expect(noticeDecision({ applyAfter: NOW }, sub({ status }), NOW)).toBe('skip');
  });
  it('skips ended subscriptions', () => expect(noticeDecision({ applyAfter: NOW }, sub({ endedAt: NOW }), NOW)).toBe('skip'));
});

describe('effectiveRenewalDate', () => {
  it('is the current renewal when apply_after is at least 48 h before it, else the next one', () => {
    const end = new Date('2026-12-01T00:00:00Z');
    expect(effectiveRenewalDate(new Date('2026-11-20T00:00:00Z'), end, 'month').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(effectiveRenewalDate(new Date('2026-11-30T12:00:00Z'), end, 'month').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(effectiveRenewalDate(new Date('2026-11-30T12:00:00Z'), end, 'year').toISOString()).toBe('2027-12-01T00:00:00.000Z');
  });
});
```

`server/src/modules/billing/__int__/priceNotices.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn(), getAdminRecipients: jest.fn(async () => []) }));

import { setupAssociations, BillingPriceNotice } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { scheduleMigration, applyDueNotices } from '../priceNotices';
import { notifyHouseholdAdmins } from '../notify';

let s: StripeMock;
const day = 86400_000;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  s = installStripeMock('test');
  const next = catalogPrices('2027-01', { monthBase: 999, monthExtra: 249, yearBase: 8999, yearExtra: 2988 }).map((p) => ({ ...p, lookup_key: null }));
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? catalogPrices().filter((x) => p.lookup_keys.includes(x.lookup_key)) : [...catalogPrices(), ...next]));
});
afterAll(() => closeIntResources());

describe('price migration', () => {
  it('schedules notices with old/new price and renewal date, idempotently', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_P', priceSet: '2026-10', currentPeriodEnd: new Date(Date.now() + 20 * day) });
    expect(await scheduleMigration('test', '2026-10', '2027-01', 30)).toEqual({ scheduled: 1, skipped: 0 });
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(household.id, 'billing_price_change', expect.any(String), expect.stringMatching(/\$8\.99 to \$9\.99 per month/), expect.anything(), { email: true });
    expect(await scheduleMigration('test', '2026-10', '2027-01', 30)).toEqual({ scheduled: 0, skipped: 0 });
    expect(await BillingPriceNotice.count()).toBe(1);
  });

  it('applies due notices with proration none for the same seats and interval', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_P' });
    const row = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_P', seats: 6, interval: 'month', currentPeriodEnd: new Date(Date.now() + 10 * day) });
    const notice = await BillingPriceNotice.create({ subscriptionId: row.id, fromPriceId: 'price_202610_6_month', toPriceSet: '2027-01', noticeSentAt: new Date(Date.now() - 31 * day), applyAfter: new Date(Date.now() - day) });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_P', customer: 'cus_P', seats: 6, itemId: 'si_P' }));
    s.subscriptions.update.mockResolvedValue({});
    expect(await applyDueNotices('test')).toMatchObject({ applied: 1 });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_P', { items: [{ id: 'si_P', price: 'price_202701_6_month' }], proration_behavior: 'none' }, { idempotencyKey: `pricenotice:${notice.id}` });
    expect((await notice.reload()).status).toBe('applied');
  });

  it('waits inside the 48 h window and skips canceled subscriptions', async () => {
    const { household } = await createHouseholdWithAdmin();
    const soon = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_S', currentPeriodEnd: new Date(Date.now() + 24 * 3600_000) });
    const gone = await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_C', status: 'canceled' });
    for (const r of [soon, gone]) {
      await BillingPriceNotice.create({ subscriptionId: r.id, fromPriceId: 'x', toPriceSet: '2027-01', noticeSentAt: new Date(), applyAfter: new Date(Date.now() - day) });
    }
    expect(await applyDueNotices('test')).toMatchObject({ applied: 0, waiting: 1, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/priceNotices.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`priceNotices.ts`:
```ts
import { Op } from 'sequelize';
import { BillingPriceNotice, BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { findPriceInSet } from './catalog';
import { getStripe } from './config';
import { formatUsd } from './copy';
import { livemodeOf } from './mode';
import { notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES, BillingInterval, BillingMode, SubscriptionStatus } from './types';

export const RENEWAL_GUARD_MS = 48 * 3600_000;

export function noticeDecision(
  notice: { applyAfter: Date },
  sub: { status: SubscriptionStatus; currentPeriodEnd: Date | null; endedAt: Date | null },
  now: Date,
): 'apply' | 'wait' | 'skip' {
  if (!ALLOWED_STATUSES.includes(sub.status) || sub.endedAt) return 'skip';
  if (now.getTime() < notice.applyAfter.getTime()) return 'wait';
  if (!sub.currentPeriodEnd || now.getTime() > sub.currentPeriodEnd.getTime() - RENEWAL_GUARD_MS) return 'wait';
  return 'apply';
}

export function effectiveRenewalDate(applyAfter: Date, currentPeriodEnd: Date, interval: BillingInterval): Date {
  if (applyAfter.getTime() <= currentPeriodEnd.getTime() - RENEWAL_GUARD_MS) return currentPeriodEnd;
  const next = new Date(currentPeriodEnd);
  if (interval === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

export async function scheduleMigration(mode: BillingMode, from: string, to: string, noticeDays: number, now: Date = new Date()): Promise<{ scheduled: number; skipped: number }> {
  if (noticeDays < 30) throw new Error('notice must be at least 30 days');
  const livemode = livemodeOf(mode);
  const subs = await BillingSubscription.findAll({ where: { livemode, provider: 'stripe', priceSet: from, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  let scheduled = 0;
  let skipped = 0;
  const applyAfter = new Date(now.getTime() + noticeDays * 86400_000);
  for (const sub of subs) {
    const target = await findPriceInSet(mode, to, sub.interval, sub.seats);
    if (!target) {
      skipped++;
      await raiseReviewItem({ livemode, kind: 'price_migration_missing_price', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId, after: { to, interval: sub.interval, seats: sub.seats } });
      continue;
    }
    const [notice, created] = await BillingPriceNotice.findOrCreate({
      where: { subscriptionId: sub.id, toPriceSet: to },
      defaults: { subscriptionId: sub.id, toPriceSet: to, fromPriceId: sub.priceId ?? 'unknown', noticeSentAt: now, applyAfter },
    });
    if (!created) continue;
    scheduled++;
    const renewal = sub.currentPeriodEnd ? effectiveRenewalDate(notice.applyAfter, sub.currentPeriodEnd, sub.interval).toISOString().slice(0, 10) : 'your next renewal';
    await notifyHouseholdAdmins(sub.householdId, 'billing_price_change', 'Your Rootaroo price is changing',
      `Your Rootaroo price is changing from ${formatUsd(sub.unitAmount ?? 0)} to ${formatUsd(target.amount)} per ${sub.interval}, starting with your renewal on ${renewal}. You can cancel any time before then in Manage subscription.`,
      { type: 'billing_price_change', renewal }, { email: true });
  }
  return { scheduled, skipped };
}

export async function applyDueNotices(mode: BillingMode, now: Date = new Date()): Promise<{ applied: number; skipped: number; failed: number; waiting: number }> {
  const livemode = livemodeOf(mode);
  const out = { applied: 0, skipped: 0, failed: 0, waiting: 0 };
  const notices = await BillingPriceNotice.findAll({ where: { status: 'scheduled' } });
  for (const notice of notices) {
    const sub = await BillingSubscription.findByPk(notice.subscriptionId);
    if (!sub || sub.livemode !== livemode) continue;
    const decision = noticeDecision(notice, sub, now);
    if (decision === 'wait') { out.waiting++; continue; }
    if (decision === 'skip') {
      await notice.update({ status: 'skipped', reason: `subscription ${sub.status}` });
      out.skipped++;
      continue;
    }
    try {
      const target = await findPriceInSet(mode, notice.toPriceSet, sub.interval, sub.seats);
      if (!target) throw new Error(`no ${notice.toPriceSet} price for ${sub.seats}/${sub.interval}`);
      if (sub.priceId !== target.priceId) {
        const stripe = getStripe(mode);
        const current = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
        await stripe.subscriptions.update(sub.providerSubscriptionId,
          { items: [{ id: current.items.data[0].id, price: target.priceId }], proration_behavior: 'none' },
          { idempotencyKey: `pricenotice:${notice.id}` });
        await upsertSubscription(sub.providerSubscriptionId, mode);
      }
      await notice.update({ status: 'applied', appliedAt: now });
      out.applied++;
    } catch (err) {
      logger.error(`[Billing] price notice ${notice.id} failed:`, err);
      await notice.update({ status: 'failed', reason: (err as Error).message.slice(0, 500) });
      await raiseReviewItem({ livemode, kind: 'price_notice_failed', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId, after: { notice: notice.id } });
      out.failed++;
    }
  }
  return out;
}
```

`server/src/jobs/billing-price-notices.ts`:
```ts
import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { applyDueNotices } from '../modules/billing/priceNotices';
import { withLock } from '../modules/billing/locks';
import { LockBusyError } from '../modules/billing/errors';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

export function startBillingPriceNoticesJob(): void {
  cron.schedule('0 5 * * *', async () => {
    for (const mode of ['test', 'live'] as BillingMode[]) {
      if (!isModeAvailable(mode)) continue;
      try {
        const r = await withLock(`billing:job:price-notices:${mode}`, 30 * 60_000, () => applyDueNotices(mode));
        if (r.applied || r.failed || r.skipped) logger.info(`[Price Notices] ${mode} ${JSON.stringify(r)}`);
      } catch (err) {
        if (!(err instanceof LockBusyError)) logger.error(`[Price Notices] ${mode} failed:`, err);
      }
    }
  }, { timezone: 'UTC' });
  logger.info('[Price Notices] Cron job registered — daily 05:00 UTC');
}
```
`index.ts`: register `startBillingPriceNoticesJob();`.

`stripe-bootstrap.ts` `main`, after the `--backfill` branch:
```ts
  if (opts.migratePrices) {
    const { setupAssociations } = await import('../../../database/models');
    const { scheduleMigration } = await import('../priceNotices');
    setupAssociations();
    const r = await scheduleMigration(opts.mode, opts.migratePrices.from, opts.migratePrices.to, opts.migratePrices.noticeDays);
    console.log(`migrate-prices ${opts.migratePrices.from} -> ${opts.migratePrices.to}: ${r.scheduled} scheduled, ${r.skipped} skipped`);
    return;
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/priceNotices.test.ts && npm run test:int -- src/modules/billing/__int__/priceNotices.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing server/src/jobs/billing-price-notices.ts server/src/index.ts
git commit -F - <<'MSG'
feat(billing): price migration notices and the daily apply job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 7 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int
cd server && npm run billing:bootstrap -- --mode test --backfill
```
Acceptance:
- All green versus baseline.
- The backfill run against the dev sandbox finishes `succeeded` and writes a `billing_reconciliation_runs` row; record its counts in `docs/superpowers/evidence/w7-reconcile.md`.
- Server boot log (`npm run dev`) lists every billing job: event sweep, checkout sweep, reconcile (daily + weekly), price notices.

---
## Wave 8: Staff billing-admin API (§11)

All routes live in `server/src/modules/billing/admin/` and mount at `/api/v1/billing-admin`, a separate router from `/api/v1/admin`. Responses: `{ success: true, data }`, list endpoints add `nextCursor`.

### Task 8.1: Billing-admin auth, IP allowlist and audit log

**Files:**
- Create: `server/src/modules/billing/admin/auth.ts`, `server/src/modules/billing/admin/routes.ts`, `server/src/modules/billing/admin/controller.ts`, `server/src/modules/billing/admin/validation.ts`, `server/src/modules/billing/admin/service.ts`
- Modify: `server/src/app.ts`, `server/src/modules/admin/routes.ts`, `server/src/shared/middleware/adminApiKey.ts`, `server/src/config/swagger.ts`
- Test: `server/src/modules/billing/__tests__/adminAuth.test.ts`, `server/src/modules/billing/__int__/adminAuth.int.test.ts`

**Interfaces:**
- Consumes: `getBillingConfig().adminKey`, `.adminIpAllowlist` (2.3); `AdminAuditLog` (2.5).
- Produces:
  - `safeEqual(a: string, b: string): boolean` (sha256 + `crypto.timingSafeEqual`)
  - `buildIpAllowlist(cidrs: string[]): BlockList | null`, `ipAllowed(list: BlockList | null, ip: string): boolean`
  - `requireBillingAdminKey: RequestHandler` (header `x-admin-billing-key`; 401 / 403 IP)
  - `auditLog(surface: 'admin' | 'billing-admin'): RequestHandler` (writes on `finish`; uses `res.locals.auditKeyLabel` and optional `res.locals.auditNote`)
  - `GET /api/v1/billing-admin/ping` → `{ success: true, data: { ok: true } }` (lets ops verify a key)

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/adminAuth.test.ts`:
```ts
import { safeEqual, buildIpAllowlist, ipAllowed } from '../admin/auth';

describe('billing-admin auth helpers', () => {
  it('compares keys in constant time regardless of length', () => {
    expect(safeEqual('a'.repeat(40), 'a'.repeat(40))).toBe(true);
    expect(safeEqual('a'.repeat(40), 'b'.repeat(40))).toBe(false);
    expect(safeEqual('short', 'a'.repeat(40))).toBe(false);
  });

  it('matches IPv4 CIDRs, single addresses, IPv4-mapped IPv6 and IPv6', () => {
    const list = buildIpAllowlist(['10.0.0.0/8', '203.0.113.7', '2001:db8::/32']);
    expect(ipAllowed(list, '10.1.2.3')).toBe(true);
    expect(ipAllowed(list, '::ffff:10.1.2.3')).toBe(true);
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '203.0.113.8')).toBe(false);
    expect(ipAllowed(list, '2001:db8::1')).toBe(true);
    expect(ipAllowed(list, 'garbage')).toBe(false);
    expect(ipAllowed(null, '1.2.3.4')).toBe(true);
  });
});
```

`server/src/modules/billing/__int__/adminAuth.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { __resetAllowlistForTests } from '../admin/auth';

const BILLING_KEY = process.env.ADMIN_BILLING_API_KEY!;
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: BILLING_KEY })); __resetAllowlistForTests(); });
afterAll(() => closeIntResources());

const settle = () => new Promise((r) => setTimeout(r, 100)); // audit rows are written on response finish

describe('billing-admin auth (B8, §11)', () => {
  it('accepts the billing key', async () => {
    const res = await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', BILLING_KEY);
    expect(res.status).toBe(200);
  });

  it('each key returns 401 on the other surface', async () => {
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-api-key', ADMIN_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', ADMIN_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/requests').set('x-admin-api-key', BILLING_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/requests').set('x-admin-billing-key', BILLING_KEY)).status).toBe(401);
  });

  it('audits every request, including rejected ones, on both surfaces', async () => {
    await request(app).get('/api/v1/billing-admin/ping?x=1').set('x-admin-billing-key', BILLING_KEY);
    await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', 'wrong');
    await request(app).get('/api/v1/admin/requests').set('x-admin-api-key', ADMIN_KEY);
    await settle();
    const rows = await AdminAuditLog.findAll();
    expect(rows.map((r) => [r.surface, r.statusCode, r.keyLabel])).toEqual(expect.arrayContaining([
      ['billing-admin', 200, 'billing-key'], ['billing-admin', 401, 'none'], ['admin', 200, 'admin-key'],
    ]));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.statusCode === 200 && r.surface === 'billing-admin'))
      .toMatchObject({ method: 'GET', path: '/api/v1/billing-admin/ping', query: { x: '1' } });
  });

  it('enforces the IP allowlist', async () => {
    installStripeMock('test', testBillingConfig({ adminKey: BILLING_KEY, adminIpAllowlist: ['203.0.113.0/24'] }));
    __resetAllowlistForTests();
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', BILLING_KEY)).status).toBe(403);
  });

  it('401 for everyone when no billing key is configured', async () => {
    installStripeMock('test', testBillingConfig({ adminKey: '' }));
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', '')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/adminAuth.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`admin/auth.ts`:
```ts
import crypto from 'crypto';
import { BlockList, isIP } from 'net';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AdminAuditLog } from '../../../database/models';
import { ForbiddenError, UnauthorizedError } from '../../../shared/utils/errors';
import logger from '../../../shared/utils/logger';
import { getBillingConfig } from '../config';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function buildIpAllowlist(cidrs: string[]): BlockList | null {
  if (cidrs.length === 0) return null;
  const list = new BlockList();
  for (const entry of cidrs) {
    const [addr, prefix] = entry.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (prefix) list.addSubnet(addr, Number(prefix), type);
    else list.addAddress(addr, type);
  }
  return list;
}

export function ipAllowed(list: BlockList | null, ip: string): boolean {
  if (!list) return true;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(clean);
  if (family === 0) return false;
  return list.check(clean, family === 6 ? 'ipv6' : 'ipv4');
}

let allowlist: { source: string; list: BlockList | null } | null = null;
export function __resetAllowlistForTests(): void { allowlist = null; }

function currentAllowlist(): BlockList | null {
  const cidrs = getBillingConfig().adminIpAllowlist;
  const source = cidrs.join(',');
  if (!allowlist || allowlist.source !== source) allowlist = { source, list: buildIpAllowlist(cidrs) };
  return allowlist.list;
}

/** Separate header and secret from /admin's x-admin-api-key (§11). */
export function requireBillingAdminKey(req: Request, res: Response, next: NextFunction): void {
  const { adminKey } = getBillingConfig();
  const provided = req.header('x-admin-billing-key');
  if (!adminKey || !provided || !safeEqual(provided, adminKey)) throw new UnauthorizedError('Invalid or missing billing admin key');
  if (!ipAllowed(currentAllowlist(), req.ip ?? '')) throw new ForbiddenError('This IP is not allowed to use the billing admin API');
  res.locals.auditKeyLabel = 'billing-key';
  next();
}

export function auditLog(surface: 'admin' | 'billing-admin'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : null;
    res.on('finish', () => {
      const note = res.locals.auditNote as Record<string, unknown> | undefined;
      AdminAuditLog.create({
        surface,
        keyLabel: (res.locals.auditKeyLabel as string | undefined) ?? 'none',
        method: req.method,
        path: req.originalUrl.split('?')[0].slice(0, 500),
        query: { ...req.query, ...(note ? { _note: note } : {}) },
        bodyDigest: body ? crypto.createHash('sha256').update(body).digest('hex') : null,
        statusCode: res.statusCode,
        ip: req.ip ?? null,
      }).catch((err: Error) => logger.error('[Audit] failed to write admin_audit_log:', err));
    });
    next();
  };
}
```

`shared/middleware/adminApiKey.ts`: rename `_res` to `res` and before `next()` add `res.locals.auditKeyLabel = 'admin-key';`.

`modules/admin/routes.ts`: before `router.use(requireAdminApiKey);` add `router.use(auditLog('admin'));` (import from `../billing/admin/auth`).

`admin/validation.ts`, `admin/service.ts`, `admin/controller.ts` start as:
```ts
// validation.ts
import { z } from 'zod';
import type { ValidationSchemas } from '../../../shared/middleware/validate';

export const modeSchema = z.enum(['test', 'live']).default('live');
export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);
export const pingSchema: ValidationSchemas = {};
```
```ts
// service.ts
export function ping(): { ok: true } { return { ok: true }; }
```
```ts
// controller.ts
import { Request, Response, NextFunction } from 'express';
import * as service from './service';

export async function ping(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: service.ping() }); } catch (e) { next(e); }
}
```
`admin/routes.ts`:
```ts
import { Router } from 'express';
import { auditLog, requireBillingAdminKey } from './auth';
import * as ctrl from './controller';

const router = Router();

// Audit first so rejected requests are logged too.
router.use(auditLog('billing-admin'));
router.use(requireBillingAdminKey);

/**
 * @openapi
 * /billing-admin/ping:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Verify a billing admin key
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: "{ ok: true }" }
 *       401: { description: Missing or wrong x-admin-billing-key }
 *       403: { description: IP not in ADMIN_BILLING_IP_ALLOWLIST }
 */
router.get('/ping', ctrl.ping);

export default router;
```
`app.ts`: `import billingAdminRouter from './modules/billing/admin/routes';` and `app.use('/api/v1/billing-admin', billingAdminRouter);` next to the `/api/v1/admin` mount.
`config/swagger.ts`: add to `securitySchemes`:
```ts
        billingAdminKey: { type: 'apiKey', in: 'header', name: 'x-admin-billing-key' },
        adminApiKey: { type: 'apiKey', in: 'header', name: 'x-admin-api-key' },
```
and change `apis` to `['./src/modules/**/routes.ts', './src/modules/billing/admin/routes.ts']` (the glob already matches; keep it explicit).

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/adminAuth.test.ts src/shared/middleware && npm run test:int -- src/modules/billing/__int__/adminAuth.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src
git commit -F - <<'MSG'
feat(billing-admin): separate staff key, IP allowlist and audit log on both admin surfaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 8.2: Transactions list, detail and CSV

**Files:**
- Modify: `server/src/modules/billing/admin/{service,controller,routes,validation}.ts`
- Test: `server/src/modules/billing/__tests__/adminCursor.test.ts`, `server/src/modules/billing/__int__/adminTransactions.int.test.ts`

**Interfaces:**
- Produces:
  - `encodeCursor(at: Date, id: string): string`, `decodeCursor(c: string | undefined): { at: Date; id: string } | null` (throws `ValidationError` on garbage)
  - `stripeDashboardUrl(provider: string, livemode: boolean, type: LedgerType, objectId: string): string | null`
  - `interface TxFilters { mode: 'test'|'live'; householdId?: string; userId?: string; email?: string; type?: LedgerType; status?: string; matchStatus?: 'matched'|'unmatched'; billingReason?: string; from?: Date; to?: Date; cursor?: string; limit: number }`
  - `interface TransactionView { id; provider; mode; type; status; billingReason; amount; fee; net; disputeFee; fundsState; currency; householdId; householdName; userId; payerEmail; subscriptionId; matchStatus; providerObjectId; providerInvoiceId; providerChargeId; receiptUrl; description; occurredAt: string; stripeDashboardUrl: string | null }`
  - `listTransactions(f: TxFilters): Promise<{ data: TransactionView[]; nextCursor: string | null }>`
  - `getTransaction(id: string): Promise<TransactionView & { subscription: Record<string, unknown> | null; household: Record<string, unknown> | null }>`
  - `writeTransactionsCsv(f: TxFilters, write: (chunk: string) => void): Promise<number>`
  - Routes `GET /transactions`, `GET /transactions.csv`, `GET /transactions/:id`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/billing/__tests__/adminCursor.test.ts`:
```ts
import { encodeCursor, decodeCursor, stripeDashboardUrl } from '../admin/service';

describe('admin helpers', () => {
  it('round-trips cursors and rejects garbage', () => {
    const at = new Date('2026-10-05T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, 'abc'))).toEqual({ at, id: 'abc' });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('!!!')).toThrow();
  });

  it('builds Stripe Dashboard links per object type and mode', () => {
    expect(stripeDashboardUrl('stripe', false, 'payment', 'in_1')).toBe('https://dashboard.stripe.com/test/invoices/in_1');
    expect(stripeDashboardUrl('stripe', true, 'refund', 're_1')).toBe('https://dashboard.stripe.com/refunds/re_1');
    expect(stripeDashboardUrl('stripe', true, 'dispute', 'dp_1')).toBe('https://dashboard.stripe.com/disputes/dp_1');
    expect(stripeDashboardUrl('apple', true, 'payment', 'x')).toBeNull();
  });
});
```

`server/src/modules/billing/__int__/adminTransactions.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingTransaction } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const get = (path: string) => request(app).get(`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY);

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

async function seed() {
  const { household, admin } = await createHouseholdWithAdmin({ name: 'Rai Family' });
  const base = { provider: 'stripe', currency: 'usd', matchStatus: 'matched', householdId: household.id, userId: admin.id, householdNameSnapshot: 'Rai Family', payerEmailSnapshot: admin.email };
  for (let i = 0; i < 5; i++) {
    await BillingTransaction.create({ ...base, livemode: true, type: 'payment', status: 'paid', amount: 899, fee: 56, net: 843, billingReason: 'subscription_cycle', providerObjectId: `in_${i}`, occurredAt: new Date(Date.UTC(2026, 9, 1 + i)) });
  }
  await BillingTransaction.create({ ...base, livemode: true, type: 'refund', status: 'succeeded', amount: 400, providerObjectId: 're_1', occurredAt: new Date(Date.UTC(2026, 9, 7)) });
  await BillingTransaction.create({ ...base, livemode: false, type: 'payment', status: 'paid', amount: 899, providerObjectId: 'in_test', occurredAt: new Date(Date.UTC(2026, 9, 7)) });
  return { household, admin };
}

describe('GET /billing-admin/transactions', () => {
  it('defaults to live mode, newest first, with links and household names', async () => {
    await seed();
    const res = await get('/transactions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
    expect(res.body.data[0]).toMatchObject({ type: 'refund', mode: 'live', householdName: 'Rai Family', stripeDashboardUrl: 'https://dashboard.stripe.com/refunds/re_1' });
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters and paginates with a cursor', async () => {
    const { household, admin } = await seed();
    const first = await get(`/transactions?type=payment&householdId=${household.id}&userId=${admin.id}&email=${encodeURIComponent(admin.email)}&billingReason=subscription_cycle&limit=2`);
    expect(first.body.data.map((t: any) => t.providerObjectId)).toEqual(['in_4', 'in_3']);
    const second = await get(`/transactions?type=payment&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data.map((t: any) => t.providerObjectId)).toEqual(['in_2', 'in_1']);
    expect((await get('/transactions?mode=test')).body.data.map((t: any) => t.providerObjectId)).toEqual(['in_test']);
    expect((await get('/transactions?from=2026-10-02T00:00:00Z&to=2026-10-03T23:59:59Z')).body.data).toHaveLength(2);
  });

  it('rejects bad filters with 400', async () => {
    expect((await get('/transactions?limit=500')).status).toBe(400);
    expect((await get('/transactions?type=gift')).status).toBe(400);
    expect((await get('/transactions?cursor=%%%')).status).toBe(400);
  });

  it('returns one transaction with its household', async () => {
    await seed();
    const t = await BillingTransaction.findOne({ where: { providerObjectId: 're_1' } });
    const res = await get(`/transactions/${t!.id}`);
    expect(res.body.data).toMatchObject({ providerObjectId: 're_1', household: { name: 'Rai Family' } });
    expect((await get('/transactions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('streams CSV with the same filters', async () => {
    await seed();
    const res = await get('/transactions.csv?type=payment');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('id,occurred_at,mode,type,status,billing_reason,amount,fee,net,dispute_fee,currency,household_id,household_name,user_id,payer_email,match_status,provider_object_id,stripe_dashboard_url');
    expect(lines).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/modules/billing/__tests__/adminCursor.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Append to `admin/service.ts`:
```ts
import { Op, WhereOptions } from 'sequelize';
import { BillingSubscription, BillingTransaction, Household } from '../../../database/models';
import type { LedgerType } from '../../../database/models/BillingTransaction';
import { NotFoundError, ValidationError } from '../../../shared/utils/errors';

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const raw = Buffer.from(c, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  const at = new Date(iso);
  if (!id || Number.isNaN(at.getTime())) throw new ValidationError('Invalid cursor');
  return { at, id };
}

export function stripeDashboardUrl(provider: string, livemode: boolean, type: LedgerType, objectId: string): string | null {
  if (provider !== 'stripe') return null;
  const path = type === 'refund' ? 'refunds' : type === 'dispute' ? 'disputes' : 'invoices';
  // Sandboxes may need the account path segment; verify the link format in the Dashboard at implementation time.
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}${path}/${objectId}`;
}

export interface TxFilters {
  mode: 'test' | 'live'; householdId?: string; userId?: string; email?: string; type?: LedgerType; status?: string;
  matchStatus?: 'matched' | 'unmatched'; billingReason?: string; from?: Date; to?: Date; cursor?: string; limit: number;
}

export interface TransactionView {
  id: string; provider: string; mode: 'test' | 'live'; type: LedgerType; status: string; billingReason: string | null;
  amount: number; fee: number | null; net: number | null; disputeFee: number | null; fundsState: string | null; currency: string;
  householdId: string | null; householdName: string | null; userId: string | null; payerEmail: string | null; subscriptionId: string | null;
  matchStatus: string; providerObjectId: string; providerInvoiceId: string | null; providerChargeId: string | null;
  receiptUrl: string | null; description: string | null; occurredAt: string; stripeDashboardUrl: string | null;
}

export function toView(t: BillingTransaction): TransactionView {
  return {
    id: t.id, provider: t.provider, mode: t.livemode ? 'live' : 'test', type: t.type, status: t.status, billingReason: t.billingReason,
    amount: t.amount, fee: t.fee, net: t.net, disputeFee: t.disputeFee, fundsState: t.fundsState, currency: t.currency,
    householdId: t.householdId, householdName: t.householdNameSnapshot, userId: t.userId, payerEmail: t.payerEmailSnapshot,
    subscriptionId: t.subscriptionId, matchStatus: t.matchStatus, providerObjectId: t.providerObjectId, providerInvoiceId: t.providerInvoiceId,
    providerChargeId: t.providerChargeId, receiptUrl: t.receiptUrl, description: t.description, occurredAt: t.occurredAt.toISOString(),
    stripeDashboardUrl: stripeDashboardUrl(t.provider, t.livemode, t.type, t.providerObjectId),
  };
}

function txWhere(f: TxFilters): WhereOptions {
  const where: Record<string | symbol, unknown> = { livemode: f.mode === 'live' };
  if (f.householdId) where.householdId = f.householdId;
  if (f.userId) where.userId = f.userId;
  if (f.email) where.payerEmailSnapshot = f.email;
  if (f.type) where.type = f.type;
  if (f.status) where.status = f.status;
  if (f.matchStatus) where.matchStatus = f.matchStatus;
  if (f.billingReason) where.billingReason = f.billingReason;
  if (f.from || f.to) where.occurredAt = { ...(f.from ? { [Op.gte]: f.from } : {}), ...(f.to ? { [Op.lte]: f.to } : {}) };
  const cursor = decodeCursor(f.cursor);
  if (cursor) where[Op.or] = [{ occurredAt: { [Op.lt]: cursor.at } }, { occurredAt: cursor.at, id: { [Op.lt]: cursor.id } }];
  return where as WhereOptions;
}

export async function listTransactions(f: TxFilters): Promise<{ data: TransactionView[]; nextCursor: string | null }> {
  const rows = await BillingTransaction.findAll({ where: txWhere(f), order: [['occurredAt', 'DESC'], ['id', 'DESC']], limit: f.limit + 1 });
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return { data: page.map(toView), nextCursor: rows.length > f.limit && last ? encodeCursor(last.occurredAt, last.id) : null };
}

export async function getTransaction(id: string) {
  const t = await BillingTransaction.findByPk(id);
  if (!t) throw new NotFoundError('Transaction');
  const subscription = t.subscriptionId ? await BillingSubscription.findByPk(t.subscriptionId) : null;
  const household = t.householdId ? await Household.findByPk(t.householdId, { paranoid: false }) : null;
  return {
    ...toView(t),
    subscription: subscription ? subscription.toJSON() : null,
    household: household ? { id: household.id, name: household.name, billingCohort: household.billingCohort, deletedAt: household.deletedAt } : null,
  };
}

const CSV_COLUMNS = ['id', 'occurred_at', 'mode', 'type', 'status', 'billing_reason', 'amount', 'fee', 'net', 'dispute_fee', 'currency', 'household_id', 'household_name', 'user_id', 'payer_email', 'match_status', 'provider_object_id', 'stripe_dashboard_url'];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeTransactionsCsv(f: TxFilters, write: (chunk: string) => void): Promise<number> {
  write(`${CSV_COLUMNS.join(',')}\n`);
  let cursor: string | undefined = f.cursor;
  let count = 0;
  for (;;) {
    const page = await listTransactions({ ...f, cursor, limit: 200 });
    for (const t of page.data) {
      write(`${[t.id, t.occurredAt, t.mode, t.type, t.status, t.billingReason, t.amount, t.fee, t.net, t.disputeFee, t.currency, t.householdId, t.householdName, t.userId, t.payerEmail, t.matchStatus, t.providerObjectId, t.stripeDashboardUrl].map(csvCell).join(',')}\n`);
      count++;
    }
    if (!page.nextCursor) return count;
    cursor = page.nextCursor;
  }
}
```

`admin/validation.ts` add:
```ts
export const transactionsQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    householdId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    type: z.enum(['payment', 'failed_payment', 'refund', 'dispute']).optional(),
    status: z.string().max(32).optional(),
    matchStatus: z.enum(['matched', 'unmatched']).optional(),
    billingReason: z.string().max(40).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: limitSchema,
  }),
};

export const idParamSchema: ValidationSchemas = { params: z.object({ id: z.string().uuid() }) };
```

`admin/controller.ts` add:
```ts
import { TxFilters } from './service';

export async function transactions(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await service.listTransactions(req.query as unknown as TxFilters);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function transaction(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getTransaction(req.params.id) }); } catch (e) { next(e); }
}

export async function transactionsCsv(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rootaroo-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    await service.writeTransactionsCsv(req.query as unknown as TxFilters, (chunk) => res.write(chunk));
    res.end();
  } catch (e) { next(e); }
}
```

`admin/routes.ts` add (before `export default`; `.csv` must precede `/:id`):
```ts
/**
 * @openapi
 * /billing-admin/transactions:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Ledger rows with household, payer, amounts, fee/net and a Stripe Dashboard link
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: householdId, schema: { type: string, format: uuid } }
 *       - { in: query, name: userId, schema: { type: string, format: uuid } }
 *       - { in: query, name: email, schema: { type: string } }
 *       - { in: query, name: type, schema: { type: string, enum: [payment, failed_payment, refund, dispute] } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: matchStatus, schema: { type: string, enum: [matched, unmatched] } }
 *       - { in: query, name: billingReason, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
 *     responses:
 *       200: { description: "{ success, data: Transaction[], nextCursor }" }
 * /billing-admin/transactions.csv:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Same filters as /transactions, streamed as CSV
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: text/csv }
 * /billing-admin/transactions/{id}:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: One transaction with its subscription and household
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Transaction }
 *       404: { description: Not found }
 */
router.get('/transactions', validate(transactionsQuerySchema), ctrl.transactions);
router.get('/transactions.csv', validate(transactionsQuerySchema), ctrl.transactionsCsv);
router.get('/transactions/:id', validate(idParamSchema), ctrl.transaction);
```
(imports: `validate` from `../../../shared/middleware/validate`, schemas from `./validation`.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx jest src/modules/billing/__tests__/adminCursor.test.ts && npm run test:int -- src/modules/billing/__int__/adminTransactions.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing-admin): transactions list, detail and CSV export with cursor pagination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 8.3: Summary, subscriptions and household view

**Files:**
- Modify: `server/src/modules/billing/admin/{service,controller,routes,validation}.ts`
- Test: `server/src/modules/billing/__int__/adminSummary.int.test.ts`

**Interfaces:**
- Produces:
  - `interface Summary { mode; from: string; to: string; currency: 'usd'; gross: number; refunds: number; disputes: number; fees: number; disputeFees: number; net: number; mrr: number; counts: { active: number; pastDue: number; inGrace: number; failedCyclePayments: number } }`
  - `getSummary(mode: 'test'|'live', from: Date, to: Date, now?: Date): Promise<Summary>`
  - `listSubscriptions(mode, status: string | undefined, cursor: string | undefined, limit: number): Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>`
  - `getHouseholdBilling(householdId: string): Promise<{ household; entitlement; subscriptions; customers; members; recentTransactions }>`
  - Routes `GET /summary`, `GET /subscriptions`, `GET /households/:id`

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__int__/adminSummary.int.test.ts`:
```ts
import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingTransaction } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createSubscriptionRow, createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const get = (path: string) => request(app).get(`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY);
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

describe('GET /billing-admin/summary (§11 arithmetic)', () => {
  it('net = gross − refunds − withdrawn disputes − fees − dispute fees; MRR from allowed subs', async () => {
    const { household } = await createHouseholdWithAdmin();
    const at = new Date('2026-10-05T00:00:00Z');
    const t = (o: Record<string, unknown>) => BillingTransaction.create({ provider: 'stripe', livemode: true, currency: 'usd', matchStatus: 'matched', householdId: household.id, occurredAt: at, ...o });
    await t({ type: 'payment', status: 'paid', amount: 7999, fee: 262, net: 7737, providerObjectId: 'in_y' });
    await t({ type: 'payment', status: 'paid', amount: 1098, fee: 62, net: 1036, providerObjectId: 'in_m' });
    await t({ type: 'refund', status: 'succeeded', amount: 500, providerObjectId: 're_ok' });
    await t({ type: 'refund', status: 'failed', amount: 300, providerObjectId: 're_bad' });
    await t({ type: 'dispute', status: 'lost', amount: 1098, disputeFee: 1500, fundsState: 'withdrawn', providerObjectId: 'dp_w' });
    await t({ type: 'dispute', status: 'won', amount: 899, disputeFee: 0, fundsState: 'reinstated', providerObjectId: 'dp_r' });
    await t({ type: 'failed_payment', status: 'failed', amount: 899, billingReason: 'subscription_cycle', providerObjectId: 'in_f' });
    await t({ type: 'failed_payment', status: 'failed', amount: 899, billingReason: 'subscription_update', providerObjectId: 'in_f2' });
    await createSubscriptionRow(household.id, { livemode: true, interval: 'year', unitAmount: 7999 });
    const other = await createHouseholdWithAdmin();
    await createSubscriptionRow(other.household.id, { livemode: true, interval: 'month', unitAmount: 1098 });
    const third = await createHouseholdWithAdmin();
    await createSubscriptionRow(third.household.id, { livemode: true, status: 'past_due', unitAmount: 899, graceUntil: new Date(Date.now() + 86400_000) });

    const res = await get('/summary?mode=live&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z');
    expect(res.body.data).toMatchObject({
      gross: 9097, refunds: 500, disputes: 1098, fees: 324, disputeFees: 1500,
      net: 9097 - 500 - 1098 - 324 - 1500,
      mrr: 667 + 1098 + 899,
      counts: { active: 2, pastDue: 1, inGrace: 1, failedCyclePayments: 1 },
    });
  });
});

describe('subscriptions and household views', () => {
  it('lists subscriptions by mode and status', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { livemode: true, status: 'active' });
    await createSubscriptionRow(household.id, { livemode: true, status: 'canceled' });
    expect((await get('/subscriptions?mode=live&status=active')).body.data).toHaveLength(1);
    expect((await get('/subscriptions?mode=live')).body.data).toHaveLength(2);
  });

  it('shows cohort, entitlement, labelled subscriptions, customers, members and transactions', async () => {
    const { household } = await createHouseholdWithAdmin({ name: 'Shah Family' });
    await addMember(household.id);
    await createCustomerRow(household.id);
    await createSubscriptionRow(household.id, { livemode: false });
    await createSubscriptionRow(household.id, { livemode: true });
    const res = await get(`/households/${household.id}`);
    expect(res.body.data).toMatchObject({ household: { name: 'Shah Family', billingCohort: 'live' }, entitlement: { allowed: true } });
    expect(res.body.data.subscriptions.map((s: any) => s.mode).sort()).toEqual(['live', 'test']);
    expect(res.body.data.members).toHaveLength(2);
    expect(res.body.data.customers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/adminSummary.int.test.ts` → FAIL (404).

- [ ] **Step 3: Implement**

Append to `admin/service.ts`:
```ts
import { BillingCustomer, HouseholdMember, User } from '../../../database/models';
import { getEntitlement } from '../entitlement';

export interface Summary {
  mode: 'test' | 'live'; from: string; to: string; currency: 'usd';
  gross: number; refunds: number; disputes: number; fees: number; disputeFees: number; net: number; mrr: number;
  counts: { active: number; pastDue: number; inGrace: number; failedCyclePayments: number };
}

export async function getSummary(mode: 'test' | 'live', from: Date, to: Date, now: Date = new Date()): Promise<Summary> {
  const livemode = mode === 'live';
  const inRange = { livemode, occurredAt: { [Op.between]: [from, to] } };
  const sum = async (field: 'amount' | 'fee' | 'disputeFee', where: Record<string, unknown>) =>
    Number((await BillingTransaction.sum(field, { where: { ...inRange, ...where } })) ?? 0);

  const gross = await sum('amount', { type: 'payment' });
  const refunds = await sum('amount', { type: 'refund', status: 'succeeded' });
  const disputes = await sum('amount', { type: 'dispute', fundsState: 'withdrawn' });
  const fees = await sum('fee', { type: 'payment' });
  const disputeFees = await sum('disputeFee', { type: 'dispute' });
  const failedCyclePayments = await BillingTransaction.count({ where: { ...inRange, type: 'failed_payment', billingReason: 'subscription_cycle' } });

  const subs = await BillingSubscription.findAll({ where: { livemode, status: { [Op.in]: ['active', 'trialing', 'past_due'] } } });
  const healthy = subs.filter((s) => s.status === 'active' || s.status === 'trialing');
  const pastDue = subs.filter((s) => s.status === 'past_due');
  const inGrace = pastDue.filter((s) => s.graceUntil && s.graceUntil.getTime() > now.getTime());
  const mrr = [...healthy, ...inGrace].reduce((acc, s) => acc + (s.interval === 'year' ? Math.round((s.unitAmount ?? 0) / 12) : s.unitAmount ?? 0), 0);

  return {
    mode, from: from.toISOString(), to: to.toISOString(), currency: 'usd',
    gross, refunds, disputes, fees, disputeFees, net: gross - refunds - disputes - fees - disputeFees, mrr,
    counts: { active: healthy.length, pastDue: pastDue.length, inGrace: inGrace.length, failedCyclePayments },
  };
}

export async function listSubscriptions(mode: 'test' | 'live', status: string | undefined, cursor: string | undefined, limit: number) {
  const where: Record<string | symbol, unknown> = { livemode: mode === 'live' };
  if (status) where.status = status;
  const c = decodeCursor(cursor);
  if (c) where[Op.or] = [{ updatedAt: { [Op.lt]: c.at } }, { updatedAt: c.at, id: { [Op.lt]: c.id } }];
  const rows = await BillingSubscription.findAll({ where: where as WhereOptions, order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((s) => ({ ...s.toJSON(), mode: s.livemode ? 'live' : 'test' })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}

export async function getHouseholdBilling(householdId: string) {
  const household = await Household.findByPk(householdId, { paranoid: false });
  if (!household) throw new NotFoundError('Household');
  const [subs, customers, members, recent] = await Promise.all([
    BillingSubscription.findAll({ where: { householdId }, order: [['createdAt', 'DESC']] }),
    BillingCustomer.findAll({ where: { householdId } }),
    HouseholdMember.findAll({ where: { householdId }, include: [{ model: User, as: 'user', required: false, paranoid: false }] }),
    BillingTransaction.findAll({ where: { householdId }, order: [['occurredAt', 'DESC']], limit: 20 }),
  ]);
  return {
    household: { id: household.id, name: household.name, billingCohort: household.billingCohort, deletedAt: household.deletedAt, scheduledDeletionAt: household.scheduledDeletionAt },
    entitlement: await getEntitlement(householdId, { bypassCache: true }),
    subscriptions: subs.map((s) => ({ ...s.toJSON(), mode: s.livemode ? 'live' : 'test' })),
    customers: customers.map((c) => ({ ...c.toJSON(), mode: c.livemode ? 'live' : 'test' })),
    members: members.map((m) => ({ userId: m.userId, role: m.role, displayName: m.user?.displayName ?? null, email: m.user?.email ?? null })),
    recentTransactions: recent.map(toView),
  };
}
```

`admin/validation.ts` add:
```ts
export const summaryQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    from: z.coerce.date().default(() => new Date(Date.now() - 30 * 86400_000)),
    to: z.coerce.date().default(() => new Date()),
  }),
};

export const subscriptionsQuerySchema: ValidationSchemas = {
  query: z.object({
    mode: modeSchema,
    status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused']).optional(),
    cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: limitSchema,
  }),
};
```

`admin/controller.ts` add:
```ts
export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; from: Date; to: Date };
    res.status(200).json({ success: true, data: await service.getSummary(q.mode, q.from, q.to) });
  } catch (e) { next(e); }
}

export async function subscriptions(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; status?: string; cursor?: string; limit: number };
    const out = await service.listSubscriptions(q.mode, q.status, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function household(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getHouseholdBilling(req.params.id) }); } catch (e) { next(e); }
}
```

`admin/routes.ts` add:
```ts
/**
 * @openapi
 * /billing-admin/summary:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: "net = gross − succeeded refunds − withdrawn dispute amounts − fees − dispute fees; MRR; subscription counts"
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Summary }
 * /billing-admin/subscriptions:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Subscriptions by mode and status
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: "{ data, nextCursor }" }
 * /billing-admin/households/{id}:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Cohort, entitlement, subscriptions in every mode (labelled), customers, members, recent transactions
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Household billing view }
 *       404: { description: Not found }
 */
router.get('/summary', validate(summaryQuerySchema), ctrl.summary);
router.get('/subscriptions', validate(subscriptionsQuerySchema), ctrl.subscriptions);
router.get('/households/:id', validate(idParamSchema), ctrl.household);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/adminSummary.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing-admin): revenue summary, subscription list and household billing view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 8.4: Review queue, manual reconciliation, event replay

**Files:**
- Modify: `server/src/modules/billing/admin/{service,controller,routes,validation}.ts`
- Test: `server/src/modules/billing/__int__/adminReview.int.test.ts`

**Interfaces:**
- Consumes: `runReconciliationLocked` (7.3), `enqueueEvent` (6.3).
- Produces: `listRuns(mode, cursor, limit)`, `listItems(mode, status, cursor, limit)`, `resolveItem(id: string, resolution: 'resolved' | 'ignored', note: string): Promise<BillingReconciliationItem>`, `replayEvent(idOrProviderId: string): Promise<BillingEvent>`; routes `GET /reconciliation/runs`, `GET /reconciliation/items`, `POST /reconciliation/run`, `POST /reconciliation/items/:id/resolve`, `POST /events/:id/replay`.

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__int__/adminReview.int.test.ts`:
```ts
jest.mock('../alerts', () => ({ runReconciliationLocked: jest.fn(async (mode: string, kind: string) => ({ id: 'run-1', kind, livemode: mode === 'live', status: 'succeeded', counts: {} })) }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingReconciliationItem, BillingReconciliationRun, BillingEvent } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { runReconciliationLocked } from '../alerts';
import { __drainForTests } from '../worker';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const call = (method: 'get' | 'post', path: string, body?: unknown) => request(app)[method](`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY).send(body as object);
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

describe('review queue', () => {
  it('lists runs and items, and resolves an item with a note', async () => {
    await BillingReconciliationRun.create({ livemode: true, kind: 'daily', startedAt: new Date(), status: 'succeeded' });
    const item = await BillingReconciliationItem.create({ livemode: true, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', resolution: 'needs_review' });
    expect((await call('get', '/reconciliation/runs?mode=live')).body.data).toHaveLength(1);
    expect((await call('get', '/reconciliation/items?mode=live&status=needs_review')).body.data).toHaveLength(1);
    const res = await call('post', `/reconciliation/items/${item.id}/resolve`, { resolution: 'resolved', note: 'Matched by hand to household X' });
    expect(res.body.data).toMatchObject({ resolution: 'resolved', resolvedBy: 'billing-key', resolutionNote: 'Matched by hand to household X' });
    expect((await call('post', `/reconciliation/items/${item.id}/resolve`, { resolution: 'auto_fixed', note: 'x' })).status).toBe(400);
  });

  it('runs a manual reconciliation for the requested mode', async () => {
    const res = await call('post', '/reconciliation/run', { mode: 'test' });
    expect(res.status).toBe(200);
    expect(runReconciliationLocked).toHaveBeenCalledWith('test', 'manual');
  });

  it('replays an event by id or provider id', async () => {
    const row = await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: 'evt_r', type: 'payment_intent.created', payload: { id: 'evt_r', type: 'payment_intent.created', data: { object: {} } }, status: 'dead', attempts: 8, receivedAt: new Date() });
    const res = await call('post', '/events/evt_r/replay');
    expect(res.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.findByPk(row.id)).toMatchObject({ status: 'ignored', attempts: 0 });
    expect((await call('post', '/events/evt_missing/replay')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/adminReview.int.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Append to `admin/service.ts`:
```ts
import { BillingEvent, BillingReconciliationItem, BillingReconciliationRun } from '../../../database/models';
import { enqueueEvent } from '../worker';

async function page<T extends { createdAt: Date; id: string }>(
  finder: (where: WhereOptions, limit: number) => Promise<T[]>, base: Record<string, unknown>, cursor: string | undefined, limit: number,
): Promise<{ data: T[]; nextCursor: string | null }> {
  const where: Record<string | symbol, unknown> = { ...base };
  const c = decodeCursor(cursor);
  if (c) where[Op.or] = [{ createdAt: { [Op.lt]: c.at } }, { createdAt: c.at, id: { [Op.lt]: c.id } }];
  const rows = await finder(where as WhereOptions, limit + 1);
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
}

export function listRuns(mode: 'test' | 'live', cursor: string | undefined, limit: number) {
  return page((where, l) => BillingReconciliationRun.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: l }), { livemode: mode === 'live' }, cursor, limit);
}

export function listItems(mode: 'test' | 'live', status: string | undefined, cursor: string | undefined, limit: number) {
  return page((where, l) => BillingReconciliationItem.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: l }),
    { livemode: mode === 'live', ...(status ? { resolution: status } : {}) }, cursor, limit);
}

export async function resolveItem(id: string, resolution: 'resolved' | 'ignored', note: string): Promise<BillingReconciliationItem> {
  const item = await BillingReconciliationItem.findByPk(id);
  if (!item) throw new NotFoundError('Review item');
  return item.update({ resolution, resolutionNote: note, resolvedBy: 'billing-key', resolvedAt: new Date() });
}

export async function replayEvent(idOrProviderId: string): Promise<BillingEvent> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrProviderId);
  const row = await BillingEvent.findOne({ where: isUuid ? { id: idOrProviderId } : { providerEventId: idOrProviderId } });
  if (!row) throw new NotFoundError('Event');
  await row.update({ status: 'received', attempts: 0, lockedAt: null, lastError: null });
  enqueueEvent(row.id);
  return row;
}
```

`admin/validation.ts` add:
```ts
export const runsQuerySchema: ValidationSchemas = { query: z.object({ mode: modeSchema, cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(), limit: limitSchema }) };
export const itemsQuerySchema: ValidationSchemas = {
  query: z.object({ mode: modeSchema, status: z.enum(['auto_fixed', 'needs_review', 'resolved', 'ignored']).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(), limit: limitSchema }),
};
export const runBodySchema: ValidationSchemas = { body: z.object({ mode: z.enum(['test', 'live']) }) };
export const resolveSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ resolution: z.enum(['resolved', 'ignored']), note: z.string().min(1).max(1000) }),
};
export const replayParamsSchema: ValidationSchemas = { params: z.object({ id: z.string().min(1).max(255) }) };
```

`admin/controller.ts` add:
```ts
import { runReconciliationLocked } from '../alerts';

export async function runs(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; cursor?: string; limit: number };
    const out = await service.listRuns(q.mode, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function items(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; status?: string; cursor?: string; limit: number };
    const out = await service.listItems(q.mode, q.status, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function runNow(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await runReconciliationLocked(req.body.mode, 'manual') }); } catch (e) { next(e); }
}

export async function resolve(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { resolution: req.body.resolution, note: req.body.note };
    res.status(200).json({ success: true, data: await service.resolveItem(req.params.id, req.body.resolution, req.body.note) });
  } catch (e) { next(e); }
}

export async function replay(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.replayEvent(req.params.id) }); } catch (e) { next(e); }
}
```

`admin/routes.ts` add (each with an `@openapi` block in the same style as Task 8.3: summary, `security: [{ billingAdminKey: [] }]`, parameters, and 200/400/404 responses):
```ts
router.get('/reconciliation/runs', validate(runsQuerySchema), ctrl.runs);
router.get('/reconciliation/items', validate(itemsQuerySchema), ctrl.items);
router.post('/reconciliation/run', validate(runBodySchema), ctrl.runNow);
router.post('/reconciliation/items/:id/resolve', validate(resolveSchema), ctrl.resolve);
router.post('/events/:id/replay', validate(replayParamsSchema), ctrl.replay);
```
The `@openapi` text for these five routes:
```ts
/**
 * @openapi
 * /billing-admin/reconciliation/runs:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Reconciliation runs (newest first)
 *     security: [{ billingAdminKey: [] }]
 *     responses: { 200: { description: "{ data, nextCursor }" } }
 * /billing-admin/reconciliation/items:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Review queue items; filter status=needs_review|auto_fixed|resolved|ignored
 *     security: [{ billingAdminKey: [] }]
 *     responses: { 200: { description: "{ data, nextCursor }" } }
 * /billing-admin/reconciliation/run:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Run a manual reconciliation for one mode now
 *     security: [{ billingAdminKey: [] }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [mode], properties: { mode: { type: string, enum: [test, live] } } } } } }
 *     responses: { 200: { description: The finished run }, 409: { description: LOCK_BUSY (a run is in progress) } }
 * /billing-admin/reconciliation/items/{id}/resolve:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Resolve or ignore a review item with a note (audited)
 *     security: [{ billingAdminKey: [] }]
 *     responses: { 200: { description: Updated item }, 404: { description: Not found } }
 * /billing-admin/events/{id}/replay:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Re-queue a stored webhook event (row id or provider event id)
 *     security: [{ billingAdminKey: [] }]
 *     responses: { 200: { description: The event row }, 404: { description: Not found } }
 */
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/adminReview.int.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/billing
git commit -F - <<'MSG'
feat(billing-admin): review queue, manual reconciliation and event replay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 8.5: Cohort changes, routing rules, combined coverage gate (L9, B8, §12)

**Files:**
- Modify: `server/src/modules/billing/admin/{service,controller,routes,validation}.ts`
- Create: `server/jest.coverage.config.js`
- Modify: `server/package.json` (`test:billing-coverage`), `server/jest.config.js` and `server/jest.int.config.js` (`displayName`)
- Test: `server/src/modules/billing/__int__/adminCohortRouting.int.test.ts`

**Interfaces:**
- Consumes: `resolveMode`, `livemodeOf` (2.3); `clearEntitlementCache` (4.1); `upsertSubscription` (5.3); `loadRules`, `replaceRoutingRules`, `clearRoutingCache`, `RuleRow` (5.4).
- Produces:
  - `changeCohort(householdId: string, body: { cohort: BillingCohort; reason: string; force?: boolean }): Promise<{ changed: boolean; from: BillingCohort; to: BillingCohort; canceledSubscriptions: string[]; expiredSessions: string[] }>` (409 `COHORT_CHANGE_BLOCKED { subscriptions, openSessions }` unless `force`)
  - Routes `POST /households/:id/cohort`, `GET /routing`, `PUT /routing`

- [ ] **Step 1: Write the failing test**

`server/src/modules/billing/__int__/adminCohortRouting.int.test.ts`:
```ts
jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../../app';
import { setupAssociations, Household, BillingCheckoutSession, BillingRoutingRule, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { stripeSubscription } from '../../../test/billing/fixtures';
import { seedDefaultRoutingRules } from '../routing';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const call = (method: 'get' | 'post' | 'put', path: string, body?: unknown) => request(app)[method](`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY).send(body as object);
let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

describe('POST /households/:id/cohort (L9, B8)', () => {
  it('changes a household without billing state and audits the reason', async () => {
    const { household } = await createHouseholdWithAdmin();
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'QA device' });
    expect(res.body.data).toMatchObject({ changed: true, from: 'live', to: 'test' });
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('test');
    await new Promise((r) => setTimeout(r, 100));
    const audit = await AdminAuditLog.findOne({ where: { path: `/api/v1/billing-admin/households/${household.id}/cohort` } });
    expect(audit!.query).toMatchObject({ _note: { from: 'live', to: 'test', reason: 'QA device', force: false } });
  });

  it('refuses while an allowed subscription or open session exists', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: 'cs_test_open', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open' });
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'COHORT_CHANGE_BLOCKED', subscriptions: 1, openSessions: 1 });
  });

  it('force sets cancel_at_period_end and expires open sessions', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_C' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_C' });
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: 'cs_test_open', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open' });
    s.subscriptions.update.mockResolvedValue({});
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_C', customer: 'cus_C', cancelAtPeriodEnd: true }));
    s.checkout.sessions.expire.mockResolvedValue({});
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'support case', force: true });
    expect(res.body.data).toMatchObject({ changed: true, canceledSubscriptions: ['sub_C'], expiredSessions: ['cs_test_open'] });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_C', { cancel_at_period_end: true }, { idempotencyKey: expect.stringContaining('cohort:sub_C') });
  });

  it('validates the body', async () => {
    const { household } = await createHouseholdWithAdmin();
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'beta', reason: 'x' })).status).toBe(400);
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'test' })).status).toBe(400);
  });
});

describe('routing rules API', () => {
  it('reads and replaces the rule set atomically', async () => {
    await seedDefaultRoutingRules('development');
    expect((await call('get', '/routing')).body.data).toHaveLength(3);
    const rules = [{ platform: 'ios', country: 'US', method: 'stripe_checkout' }, { platform: 'ios', country: '*', method: 'apple_iap' }];
    expect((await call('put', '/routing', { rules })).status).toBe(200);
    expect(await BillingRoutingRule.count()).toBe(2);
    expect((await call('put', '/routing', { rules: [...rules, rules[0]] })).status).toBe(400);
    expect(await BillingRoutingRule.count()).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm run test:int -- src/modules/billing/__int__/adminCohortRouting.int.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Append to `admin/service.ts`:
```ts
import { BillingCheckoutSession } from '../../../database/models';
import { getStripe } from '../config';
import { clearEntitlementCache } from '../entitlement';
import { BillingConflictError } from '../errors';
import { livemodeOf, resolveMode } from '../mode';
import { upsertSubscription } from '../sync';
import { loadRules, clearRoutingCache, replaceRoutingRules, RuleRow } from '../routing';
import { ALLOWED_STATUSES, BillingCohort } from '../types';
import logger from '../../../shared/utils/logger';

export async function changeCohort(householdId: string, body: { cohort: BillingCohort; reason: string; force?: boolean }) {
  const household = await Household.findByPk(householdId, { paranoid: false });
  if (!household) throw new NotFoundError('Household');
  const from = household.billingCohort;
  if (from === body.cohort) return { changed: false, from, to: body.cohort, canceledSubscriptions: [] as string[], expiredSessions: [] as string[] };

  const mode = resolveMode(household);
  const livemode = livemodeOf(mode);
  const subs = await BillingSubscription.findAll({ where: { householdId, livemode, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  const sessions = await BillingCheckoutSession.findAll({ where: { householdId, livemode, status: { [Op.in]: ['open', 'creating'] } } });
  if ((subs.length > 0 || sessions.length > 0) && !body.force) {
    throw new BillingConflictError('COHORT_CHANGE_BLOCKED', 'This household has an active subscription or an open checkout in its current mode. Pass force to proceed.',
      { subscriptions: subs.length, openSessions: sessions.length });
  }

  const canceledSubscriptions: string[] = [];
  const expiredSessions: string[] = [];
  if (body.force) {
    const stripe = getStripe(mode);
    for (const sub of subs) {
      if (sub.provider !== 'stripe' || sub.cancelAtPeriodEnd) continue;
      await stripe.subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `cohort:${sub.providerSubscriptionId}:${Date.now()}` });
      await upsertSubscription(sub.providerSubscriptionId, mode);
      canceledSubscriptions.push(sub.providerSubscriptionId);
    }
    for (const session of sessions) {
      if (session.providerSessionId) {
        await stripe.checkout.sessions.expire(session.providerSessionId).catch((err: Error) => logger.warn(`[Billing] expire ${session.providerSessionId}: ${err.message}`));
        expiredSessions.push(session.providerSessionId);
      }
      await session.update({ status: 'expired' });
    }
  }

  await household.update({ billingCohort: body.cohort });
  await clearEntitlementCache(householdId);
  return { changed: true, from, to: body.cohort, canceledSubscriptions, expiredSessions };
}

export async function getRouting(): Promise<RuleRow[]> {
  clearRoutingCache();
  return loadRules();
}

export function putRouting(rules: RuleRow[]): Promise<RuleRow[]> {
  return replaceRoutingRules(rules, 'billing-key');
}
```

`admin/validation.ts` add:
```ts
export const cohortSchema: ValidationSchemas = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ cohort: z.enum(['live', 'test']), reason: z.string().min(3).max(500), force: z.boolean().optional().default(false) }),
};

export const routingSchema: ValidationSchemas = {
  body: z.object({
    rules: z.array(z.object({
      platform: z.enum(['ios', 'android', 'web']),
      country: z.string().regex(/^(\*|[A-Z]{2})$/),
      method: z.enum(['stripe_checkout', 'apple_iap', 'google_play', 'none']),
    })).min(1).max(500),
  }),
};
```

`admin/controller.ts` add:
```ts
export async function cohort(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await service.changeCohort(req.params.id, req.body);
    res.locals.auditNote = { from: out.from, to: out.to, reason: req.body.reason, force: req.body.force };
    res.status(200).json({ success: true, data: out });
  } catch (e) {
    res.locals.auditNote = { to: req.body?.cohort, reason: req.body?.reason, force: req.body?.force, refused: true };
    next(e);
  }
}

export async function routing(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getRouting() }); } catch (e) { next(e); }
}

export async function putRouting(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { rules: req.body.rules.length };
    res.status(200).json({ success: true, data: await service.putRouting(req.body.rules) });
  } catch (e) { next(e); }
}
```

`admin/routes.ts` add:
```ts
/**
 * @openapi
 * /billing-admin/households/{id}/cohort:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Change a household's billing cohort (live/test). Audited; refused with an active subscription or open checkout unless force.
 *     security: [{ billingAdminKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cohort, reason]
 *             properties:
 *               cohort: { type: string, enum: [live, test] }
 *               reason: { type: string }
 *               force: { type: boolean, description: "Sets cancel_at_period_end and expires open sessions" }
 *     responses:
 *       200: { description: "{ changed, from, to, canceledSubscriptions, expiredSessions }" }
 *       409: { description: "COHORT_CHANGE_BLOCKED { subscriptions, openSessions }" }
 * /billing-admin/routing:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Current routing rules
 *     security: [{ billingAdminKey: [] }]
 *     responses: { 200: { description: Rule[] } }
 *   put:
 *     tags: [BillingAdmin]
 *     summary: Replace all routing rules in one transaction (audited)
 *     security: [{ billingAdminKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rules]
 *             properties:
 *               rules:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     platform: { type: string, enum: [ios, android, web] }
 *                     country: { type: string, example: US }
 *                     method: { type: string, enum: [stripe_checkout, apple_iap, google_play, none] }
 *     responses: { 200: { description: Rule[] }, 400: { description: Invalid or duplicate rule } }
 */
router.post('/households/:id/cohort', validate(cohortSchema), ctrl.cohort);
router.get('/routing', ctrl.routing);
router.put('/routing', validate(routingSchema), ctrl.putRouting);
```

- [ ] **Step 4: Add the combined coverage run**

`server/jest.config.js`: add `displayName: 'unit',`. `server/jest.int.config.js`: add `displayName: 'int',`.
`server/jest.coverage.config.js`:
```js
/** Unit + integration together, for the ≥ 90 % billing coverage target (spec §13.1). */
module.exports = {
  projects: ['<rootDir>/jest.config.js', '<rootDir>/jest.int.config.js'],
  collectCoverageFrom: ['<rootDir>/src/modules/billing/**/*.ts', '!<rootDir>/src/modules/billing/scripts/**', '!<rootDir>/src/modules/billing/**/__tests__/**', '!<rootDir>/src/modules/billing/**/__int__/**'],
  coverageThreshold: { global: { lines: 90, statements: 90, functions: 90, branches: 80 } },
};
```
`server/package.json` scripts: `"test:billing-coverage": "jest -c jest.coverage.config.js --runInBand --coverage"`.

- [ ] **Step 5: Run to verify**

```bash
cd server && npm run test:int -- src/modules/billing/__int__/adminCohortRouting.int.test.ts && npm run type-check
cd server && npm run test:billing-coverage
```
Expected: PASS; coverage thresholds met. If a file is under 90 % lines, add the missing cases to that file's existing test (not new test files).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing server/jest.config.js server/jest.int.config.js server/jest.coverage.config.js server/package.json
git commit -F - <<'MSG'
feat(billing-admin): audited cohort changes, routing rules API, combined coverage gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 8 gate

Run:
```bash
cd server && npx jest && npm run type-check && npm run lint && npm run test:int && npm run test:billing-coverage
cd server && npm run dev   # then, in another shell:
curl -s localhost:3000/api-docs.json | node -e "const s=JSON.parse(require('fs').readFileSync(0));const p=Object.keys(s.paths).filter(k=>k.startsWith('/billing'));console.log(p.length, p.join('\n'))"
```
Acceptance:
- All green; billing coverage ≥ 90 % lines (unit + int).
- `/api-docs.json` lists every `/billing/*` and `/billing-admin/*` route of §11 with the `billingAdminKey` scheme.
- Manual (orchestrator, with `$ADMIN_BILLING_API_KEY` from the env, never printed): `curl -s -H "x-admin-billing-key: $ADMIN_BILLING_API_KEY" localhost:3000/api/v1/billing-admin/summary?mode=test` returns `success: true`; the same call with `$ADMIN_API_KEY` returns 401. Evidence in `docs/superpowers/evidence/w8-staff-api.md` (responses only).

---
## Wave 9: Mobile (§7.4, §8.2, §6.2)

Before any step in this wave, read the Expo SDK 54 docs the step names (`mobile/AGENTS.md`). Relevant pages: `https://docs.expo.dev/versions/v54.0.0/sdk/webbrowser/` (openAuthSessionAsync result types), `https://docs.expo.dev/develop/unit-testing/` (jest-expo), `https://docs.expo.dev/versions/v54.0.0/sdk/async-storage/`.

### Task 9.1: Test setup, billing API, 402 interceptor and `billingStore`

**Files:**
- Create: `mobile/jest.config.js`, `mobile/jest.setup.js`, `mobile/src/shared/api/billing.js`, `mobile/src/shared/store/billingStore.js`, `mobile/src/shared/billing/__tests__/fixtures.js`
- Modify: `mobile/package.json` (devDependencies, `test` script), `mobile/src/shared/api/client.js`, `mobile/src/shared/store/authStore.js` (`logout` resets billing)
- Test: `mobile/src/shared/store/__tests__/billingStore.test.js`, `mobile/src/shared/api/__tests__/client402.test.js`

**Interfaces:**
- Produces:
  - `billingApi.getStatus(): Promise<BillingStatus>`, `.getPlans()`, `.createCheckout({ interval, seats }): Promise<{ url, sessionId }>`, `.syncCheckout(sessionId): Promise<{ entitlement, pendingCheckout }>`, `.openPortal(): Promise<{ url }>`, `.changePlan({ interval, seats }): Promise<{ changed, pendingUpdate, hostedInvoiceUrl, entitlement }>`
  - `client.js`: `setPaymentRequiredHandler(fn: (body) => void): void`, `platformHeaders(): { 'X-Platform': string, 'X-Store-Country': string }`
  - `useBillingStore` state `{ status, userId, lastFetchedAt, error, noHousehold }` and actions `hydrate(userId)`, `refresh()` (single-flight; network errors keep the last status), `applySync(syncResult)`, `reset()`; `selectGate(state): 'unknown'|'allowed'|'grace'|'blocked'`; `BILLING_STORAGE_KEY = 'rootaroo_billing_status_v1'`
  - fixture `PLANS` (the §6.1 matrix) and `statusFixture(overrides)`

- [ ] **Step 1: Install the test toolchain**

```bash
cd mobile && npx expo install jest-expo jest @testing-library/react-native react-test-renderer -- --save-dev
```
Add to `mobile/package.json` scripts: `"test": "jest"`.

`mobile/jest.config.js`:
```js
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg)',
  ],
};
```
`mobile/jest.setup.js`:
```js
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), openBrowserAsync: jest.fn() }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}), deleteItemAsync: jest.fn(async () => {}) }));
// Visual-only native views: render as plain Views in tests.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Stub = (props) => React.createElement(View, props);
  return { __esModule: true, default: Stub, Svg: Stub, Path: Stub, Circle: Stub, Rect: Stub, G: Stub };
});
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { LinearGradient: (props) => React.createElement(View, props) };
});
```
`mobile/src/shared/billing/__tests__/fixtures.js`:
```js
const SIZES = [5, 6, 7, 8, 9, 10];
const month = (n) => 899 + 199 * (n - 5);
const year = (n) => 7999 + 2388 * (n - 5);

export const PLANS = {
  mode: 'test', priceSet: '2026-10', currency: 'usd', seatsIncluded: 5, seatsMax: 10,
  matrix: {
    month: Object.fromEntries(SIZES.map((n) => [String(n), { priceId: `price_m${n}`, amount: month(n) }])),
    year: Object.fromEntries(SIZES.map((n) => [String(n), { priceId: `price_y${n}`, amount: year(n) }])),
  },
};

export function statusFixture(overrides = {}) {
  return {
    entitlement: { allowed: false, reason: 'subscription_required', mode: 'test', subscription: null, graceUntil: null, seatsAllowed: 5 },
    subscription: null, isAdmin: true, adminNames: ['Asha'], purchaseMethod: 'stripe_checkout', plans: PLANS,
    pendingCheckout: null, memberCount: 3, ...overrides,
  };
}

test.skip('fixtures module', () => {});
```
(Jest's `testMatch` picks up every file under `__tests__`; the skipped test keeps this helper file from failing as an empty suite.)

- [ ] **Step 2: Write the failing tests**

`mobile/src/shared/store/__tests__/billingStore.test.js`:
```js
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../../api/billing', () => ({ billingApi: { getStatus: jest.fn() } }));
jest.mock('../../api/client', () => ({ setPaymentRequiredHandler: jest.fn() }));

const { billingApi } = require('../../api/billing');
const { setPaymentRequiredHandler } = require('../../api/client');
const { useBillingStore, selectGate, BILLING_STORAGE_KEY } = require('../billingStore');
const { statusFixture } = require('../../billing/__tests__/fixtures');

beforeEach(async () => {
  jest.clearAllMocks();
  useBillingStore.getState().reset();
  await AsyncStorage.clear();
});

describe('billingStore', () => {
  it('registers itself as the 402 handler', () => {
    expect(setPaymentRequiredHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('refresh is single-flight: a burst of calls makes one request', async () => {
    let resolve;
    billingApi.getStatus.mockReturnValue(new Promise((r) => { resolve = r; }));
    const calls = [useBillingStore.getState().refresh(), useBillingStore.getState().refresh(), useBillingStore.getState().refresh()];
    resolve(statusFixture());
    await Promise.all(calls);
    expect(billingApi.getStatus).toHaveBeenCalledTimes(1);
    expect(selectGate(useBillingStore.getState())).toBe('blocked');
  });

  it('network errors keep the last-known status (gate unchanged)', async () => {
    billingApi.getStatus.mockResolvedValueOnce(statusFixture({ entitlement: { allowed: true, reason: 'active' } }));
    await useBillingStore.getState().refresh();
    billingApi.getStatus.mockRejectedValueOnce(new Error('Network Error'));
    await useBillingStore.getState().refresh();
    expect(selectGate(useBillingStore.getState())).toBe('allowed');
    expect(useBillingStore.getState().error).toBe('Network Error');
  });

  it('NO_HOUSEHOLD clears the gate instead of blocking', async () => {
    billingApi.getStatus.mockRejectedValueOnce({ response: { status: 403, data: { code: 'NO_HOUSEHOLD' } } });
    await useBillingStore.getState().refresh();
    expect(useBillingStore.getState()).toMatchObject({ status: null, noHousehold: true });
    expect(selectGate(useBillingStore.getState())).toBe('unknown');
  });

  it('persists per user and hydrates only for the same user', async () => {
    await useBillingStore.getState().hydrate('u1');
    billingApi.getStatus.mockResolvedValueOnce(statusFixture());
    await useBillingStore.getState().refresh();
    expect(JSON.parse(await AsyncStorage.getItem(BILLING_STORAGE_KEY)).userId).toBe('u1');
    useBillingStore.setState({ status: null });
    await useBillingStore.getState().hydrate('u2');
    expect(useBillingStore.getState().status).toBeNull();
    await useBillingStore.getState().hydrate('u1');
    expect(useBillingStore.getState().status).not.toBeNull();
  });

  it('maps grace and allowed', () => {
    expect(selectGate({ status: statusFixture({ entitlement: { allowed: true, reason: 'grace' } }) })).toBe('grace');
    expect(selectGate({ status: statusFixture({ entitlement: { allowed: true, reason: 'test_cohort' } }) })).toBe('allowed');
    expect(selectGate({ status: null })).toBe('unknown');
  });

  it('applySync updates entitlement and pending checkout', async () => {
    billingApi.getStatus.mockResolvedValueOnce(statusFixture());
    await useBillingStore.getState().refresh();
    useBillingStore.getState().applySync({ entitlement: { allowed: true, reason: 'active' }, pendingCheckout: { sessionId: 'cs', state: 'complete' } });
    expect(useBillingStore.getState().status).toMatchObject({ entitlement: { allowed: true }, pendingCheckout: null });
  });
});
```

`mobile/src/shared/api/__tests__/client402.test.js`:
```js
jest.mock('../../store/authStore', () => ({ useAuthStore: { getState: () => ({ accessToken: 't', refreshToken: 'r', user: {}, logout: jest.fn(), setAuth: jest.fn() }) } }));

const { default: apiClient, setPaymentRequiredHandler, platformHeaders } = require('../client');

describe('api client billing hooks', () => {
  it('sends platform and store-country headers', async () => {
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers).toMatchObject(platformHeaders());
    expect(['ios', 'android', 'web']).toContain(config.headers['X-Platform']);
    expect(config.headers['X-Store-Country']).toBe('ZZ');
  });

  it('routes every 402 to the payment-required handler and still rejects', async () => {
    const handler = jest.fn();
    setPaymentRequiredHandler(handler);
    const error = { config: {}, response: { status: 402, data: { code: 'SUBSCRIPTION_REQUIRED' } } };
    await expect(apiClient.interceptors.response.handlers[0].rejected(error)).rejects.toBe(error);
    expect(handler).toHaveBeenCalledWith({ code: 'SUBSCRIPTION_REQUIRED' });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd mobile && npx jest src/shared`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`mobile/src/shared/api/billing.js`:
```js
import apiClient from './client';

export const billingApi = {
  getStatus: () => apiClient.get('/billing/status').then((r) => r.data.data),
  getPlans: () => apiClient.get('/billing/plans').then((r) => r.data.data),
  createCheckout: ({ interval, seats }) => apiClient.post('/billing/checkout', { interval, seats }).then((r) => r.data.data),
  syncCheckout: (sessionId) => apiClient.post(`/billing/checkout/${encodeURIComponent(sessionId)}/sync`).then((r) => r.data.data),
  openPortal: () => apiClient.post('/billing/portal').then((r) => r.data.data),
  changePlan: ({ interval, seats }) => apiClient.post('/billing/plan', { interval, seats }).then((r) => r.data.data),
};
```

`mobile/src/shared/api/client.js` additions:
```js
// ── Billing hooks ──
// A 402 from any guarded route means entitlement changed server-side; the
// billing store registers a single-flight refresh here (no import cycle).
let paymentRequiredHandler = null;

export function setPaymentRequiredHandler(fn) {
  paymentRequiredHandler = fn;
}

// Routing (spec §12): which purchase flow the server offers depends on the
// platform and store country. Until the IAP modules exist, the country is ZZ.
export function platformHeaders() {
  return {
    'X-Platform': Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    'X-Store-Country': 'ZZ',
  };
}
```
In the request interceptor, inside `if (config.headers) { … }` add:
```js
      Object.entries(platformHeaders()).forEach(([k, v]) => { config.headers[k] = v; });
```
At the top of the response interceptor's error callback (before the 401 branch):
```js
    if (error.response?.status === 402 && paymentRequiredHandler) {
      try { paymentRequiredHandler(error.response.data); } catch { /* never block the original rejection */ }
    }
```

`mobile/src/shared/store/billingStore.js`:
```js
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { billingApi } from '../api/billing';
import { setPaymentRequiredHandler } from '../api/client';

export const BILLING_STORAGE_KEY = 'rootaroo_billing_status_v1';

let inflight = null;

export const useBillingStore = create((set, get) => ({
  status: null,
  userId: null,
  lastFetchedAt: null,
  error: null,
  noHousehold: false,

  // Last-known status from disk, so a cold start offline keeps the same gate.
  hydrate: async (userId) => {
    set({ userId });
    try {
      const raw = await AsyncStorage.getItem(BILLING_STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.userId === userId && !get().status) set({ status: saved.status, lastFetchedAt: saved.at });
    } catch {
      /* unreadable cache: wait for the network */
    }
  },

  // Single-flight: concurrent callers (a burst of 402s) share one request.
  refresh: () => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const status = await billingApi.getStatus();
        const at = Date.now();
        set({ status, lastFetchedAt: at, error: null, noHousehold: false });
        AsyncStorage.setItem(BILLING_STORAGE_KEY, JSON.stringify({ userId: get().userId, status, at })).catch(() => {});
        return status;
      } catch (e) {
        if (e?.response?.status === 403 && e?.response?.data?.code === 'NO_HOUSEHOLD') {
          set({ status: null, noHousehold: true, error: null });
          return null;
        }
        // Network errors never change the gate: keep the last-known status.
        set({ error: e?.message || 'network' });
        return get().status;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  applySync: (sync) => {
    const { status } = get();
    if (!status || !sync) return;
    set({
      status: {
        ...status,
        entitlement: sync.entitlement,
        pendingCheckout: sync.pendingCheckout && sync.pendingCheckout.state !== 'complete' ? sync.pendingCheckout : null,
      },
    });
  },

  reset: () => {
    inflight = null;
    set({ status: null, userId: null, lastFetchedAt: null, error: null, noHousehold: false });
    AsyncStorage.removeItem(BILLING_STORAGE_KEY).catch(() => {});
  },
}));

export function selectGate(state) {
  const s = state.status;
  if (!s || !s.entitlement) return 'unknown';
  if (!s.entitlement.allowed) return 'blocked';
  return s.entitlement.reason === 'grace' ? 'grace' : 'allowed';
}

setPaymentRequiredHandler(() => {
  useBillingStore.getState().refresh();
});
```

`authStore.js` `logout`: after `clearScreenCache();` add:
```js
    // Lazy require: billingStore → api → client → authStore would be a cycle at import time.
    try { require('./billingStore').useBillingStore.getState().reset(); } catch { /* not loaded yet */ }
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd mobile && npx jest src/shared`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/jest.config.js mobile/jest.setup.js mobile/package.json mobile/package-lock.json mobile/src/shared
git commit -F - <<'MSG'
feat(mobile-billing): billing API, single-flight 402 refresh and persisted billing store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.2: Pricing from `/billing/plans`; remove the `PRICE` constant (§6.2)

**Files:**
- Create: `mobile/src/shared/billing/pricing.js`
- Modify: `mobile/src/screens/onboarding/featureTourContent.js` (delete `PRICE`, new `derivePricing`), `mobile/src/screens/onboarding/FeaturePricingScreen.jsx` (read plans from the store)
- Test: `mobile/src/shared/billing/__tests__/pricing.test.js`

**Interfaces:**
- Produces: `formatCents(cents): string`, `planAmount(plans, interval, seats): number`, `autoRenewDisclosure(cents, interval): string` (byte-identical to the server's `copy.ts`), `seatRange(plans, memberCount): { min, max, overCap }`; `featureTourContent.js`: `ELSEWHERE_YEARLY = 399`, `derivePricing(plan, size, plans)` (adds `amountCents`).

- [ ] **Step 1: Write the failing test**

`mobile/src/shared/billing/__tests__/pricing.test.js`:
```js
import { formatCents, planAmount, autoRenewDisclosure, seatRange } from '../pricing';
import { derivePricing } from '../../../screens/onboarding/featureTourContent';
import * as tour from '../../../screens/onboarding/featureTourContent';
import { PLANS } from './fixtures';

describe('pricing (all 12 amounts come from the server matrix)', () => {
  it.each([[5, 899, 7999], [6, 1098, 10387], [7, 1297, 12775], [8, 1496, 15163], [9, 1695, 17551], [10, 1894, 19939]])(
    '%i members', (n, m, y) => {
      expect(planAmount(PLANS, 'month', n)).toBe(m);
      expect(planAmount(PLANS, 'year', n)).toBe(y);
    });

  it('throws for a size the matrix lacks', () => expect(() => planAmount(PLANS, 'month', 11)).toThrow());

  it('formats and discloses exactly like the server', () => {
    expect(formatCents(12775)).toBe('$127.75');
    expect(autoRenewDisclosure(899, 'month')).toBe('Renews automatically at $8.99 per month until cancelled. Cancel anytime in Manage subscription.');
  });

  it('seat range starts at max(5, members) and flags over-cap households (Review Focus 3)', () => {
    expect(seatRange(PLANS, 3)).toEqual({ min: 5, max: 10, overCap: false });
    expect(seatRange(PLANS, 7)).toEqual({ min: 7, max: 10, overCap: false });
    expect(seatRange(PLANS, 11)).toEqual({ min: 11, max: 10, overCap: true });
  });

  it('the PRICE constant is gone', () => {
    expect(tour.PRICE).toBeUndefined();
  });
});

describe('derivePricing', () => {
  it('5 members monthly', () => {
    expect(derivePricing('month', 5, PLANS)).toMatchObject({
      amountCents: 899, bigWhole: '8', bigCents: '.99', payLabel: 'Subscribe · $8.99/mo', extras: 0,
      extraLine: 'Add more any time for $1.99/mo each', savedAmount: '$291', rootYearly: '$107.88/YR',
    });
  });

  it('7 members yearly', () => {
    expect(derivePricing('year', 7, PLANS)).toMatchObject({
      amountCents: 12775, payLabel: 'Subscribe · $127.75/yr', headSub: '7 people · about $10.65 a month',
      extraLine: '2 extra members · +$3.98/mo', payFine: '7 members · 5 included, 2 × $1.99/mo · cancel any time',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/shared/billing/__tests__/pricing.test.js` → FAIL.

- [ ] **Step 3: Implement**

`mobile/src/shared/billing/pricing.js`:
```js
// Every displayed price comes from GET /billing/plans (spec §6.2); nothing is hard-coded.
export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function planAmount(plans, interval, seats) {
  const cell = plans?.matrix?.[interval]?.[String(seats)];
  if (!cell) throw new Error(`No ${interval} price for ${seats} members`);
  return cell.amount;
}

// Must match server/src/modules/billing/copy.ts autoRenewDisclosure exactly.
export function autoRenewDisclosure(cents, interval) {
  return `Renews automatically at ${formatCents(cents)} per ${interval} until cancelled. Cancel anytime in Manage subscription.`;
}

export function seatRange(plans, memberCount) {
  const min = Math.max(plans.seatsIncluded, memberCount || 0);
  return { min, max: plans.seatsMax, overCap: min > plans.seatsMax };
}
```

`featureTourContent.js`: delete the `PRICE` export and replace `derivePricing` with:
```js
import { planAmount } from '../../shared/billing/pricing';

/** What the same five apps cost a family per year elsewhere (marketing comparison, not a Rootaroo price). */
export const ELSEWHERE_YEARLY = 399;

/**
 * Every derived string the pricing screen renders, from the server's plan matrix
 * (GET /billing/plans). `plans` is required: there are no client-side prices.
 */
export function derivePricing(plan, size, plans) {
  const year = plan === 'year';
  const included = plans.seatsIncluded;
  const extras = Math.max(0, size - included);
  const monthCents = planAmount(plans, 'month', size);
  const yearCents = planAmount(plans, 'year', size);
  const extraMonthCents = planAmount(plans, 'month', included + 1) - planAmount(plans, 'month', included);
  const monthTotal = (monthCents / 100).toFixed(2);
  const yearTotal = (yearCents / 100).toFixed(2);
  const extraEach = (extraMonthCents / 100).toFixed(2);
  const effYearCents = year ? yearCents : monthCents * 12;
  const effYear = (effYearCents / 100).toFixed(2);
  const big = year ? yearTotal : monthTotal;

  return {
    year,
    extras,
    amountCents: year ? yearCents : monthCents,
    bigWhole: big.split('.')[0],
    bigCents: '.' + big.split('.')[1],
    bigPerShort: year ? 'per year' : 'per month',
    headSub: year ? `${size} people · about $${(yearCents / 1200).toFixed(2)} a month` : `${size} people · cancel any time`,
    extraLine: extras
      ? `${extras} extra ${extras === 1 ? 'member' : 'members'} · +$${((extras * extraMonthCents) / 100).toFixed(2)}/mo`
      : `Add more any time for $${extraEach}/mo each`,
    savedAmount: '$' + Math.max(0, Math.round(ELSEWHERE_YEARLY - effYearCents / 100)),
    savedSub: year
      ? 'One bill, one login, every feature we add next'
      : `Yearly drops it to $${yearTotal} — save $${((monthCents * 12 - yearCents) / 100).toFixed(2)} more`,
    goldW: Math.round(Math.min(100, (effYearCents / 100 / ELSEWHERE_YEARLY) * 100)) + '%',
    rootYearly: `$${effYear}/YR`,
    payLabel: year ? `Subscribe · $${yearTotal}/yr` : `Subscribe · $${monthTotal}/mo`,
    payFine: extras
      ? `${size} members · ${included} included, ${extras} × $${extraEach}/mo · cancel any time`
      : `${size} of ${included} included members · cancel any time`,
  };
}
```

`FeaturePricingScreen.jsx` (prices only; purchase wiring is Task 9.6):
- imports: replace `PRICE, derivePricing` with `derivePricing`; add `ActivityIndicator` to the react-native import; add `import { useBillingStore } from '../../shared/store/billingStore';` and `import { seatRange } from '../../shared/billing/pricing';`
- replace the first three lines of the component body with:
```jsx
  const status = useBillingStore((s) => s.status);
  const plans = status?.plans ?? null;
  const range = plans ? seatRange(plans, status?.memberCount ?? 1) : { min: 5, max: 10, overCap: false };
  const [plan, setPlan] = useState('year');
  const [size, setSize] = useState(range.min);
  useEffect(() => { useBillingStore.getState().refresh(); }, []);
  useEffect(() => { setSize((s) => Math.min(Math.max(s, range.min), range.max)); }, [range.min, range.max]);
  const p = plans ? derivePricing(plan, Math.min(size, range.max), plans) : null;
```
- before `return (`, add an early return while prices load:
```jsx
  if (!p) {
    return (
      <FeatureTourShell step={3} navigation={navigation} contentPadding={22} ctaLabel="Loading prices…" onContinue={() => {}}>
        <ActivityIndicator style={{ marginTop: 80 }} color={colors.gold} />
      </FeatureTourShell>
    );
  }
```
- stepper: `disabled={size <= range.min}`, `onPress={() => setSize((s) => Math.max(range.min, s - 1))}`, `disabled={size >= range.max}`, `onPress={() => setSize((s) => Math.min(range.max, s + 1))}`.
- update the file's header comment: the screen now shows server prices; payment is wired in Task 9.6.

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/shared/billing && git grep -n "PRICE\b" -- mobile/src`
Expected: PASS; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add mobile/src
git commit -F - <<'MSG'
feat(mobile-billing): prices from /billing/plans, remove the hard-coded PRICE constant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.3: Purchase flow helper (§8.2 in the app, T3, T4)

**Files:**
- Create: `mobile/src/shared/billing/purchase.js`, `mobile/src/shared/billing/legalLinks.js`
- Test: `mobile/src/shared/billing/__tests__/purchase.test.js`

**Interfaces:**
- Produces:
  - `RETURN_URL = 'rootaroo://billing'`
  - `startStripeCheckout({ interval, seats }, deps?): Promise<{ outcome: 'unlocked'|'confirming'|'not_completed'|'error', status, error? }>`
  - `pollUntilSettled(deps, timeoutMs, everyMs): Promise<status|null>`
  - `openBillingPortal(deps?): Promise<status>`
  - `describeCheckoutError(err): { title, message, portalUrl? }`
  - `defaultDeps` `{ api, openAuthSession, openBrowser, refreshStatus, applySync, sleep, now }`
  - `legalLinks.js`: `TERMS_URL`, `PRIVACY_URL`, `STORE_SUBSCRIPTION_URLS = { apple, google }`

- [ ] **Step 1: Write the failing test**

`mobile/src/shared/billing/__tests__/purchase.test.js`:
```js
jest.mock('../../api/billing', () => ({ billingApi: {} }));
jest.mock('../../store/billingStore', () => ({ useBillingStore: { getState: () => ({ refresh: jest.fn(), applySync: jest.fn() }) } }));

import { startStripeCheckout, openBillingPortal, describeCheckoutError, RETURN_URL } from '../purchase';

function deps(overrides = {}) {
  let t = 0;
  return {
    api: {
      createCheckout: jest.fn(async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' })),
      syncCheckout: jest.fn(async () => ({ entitlement: { allowed: true }, pendingCheckout: { sessionId: 'cs_test_1', state: 'complete' } })),
      openPortal: jest.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' })),
    },
    openAuthSession: jest.fn(async () => ({ type: 'success', url: 'rootaroo://billing/success?session_id=cs_test_1' })),
    openBrowser: jest.fn(),
    refreshStatus: jest.fn(async () => ({ entitlement: { allowed: true } })),
    applySync: jest.fn(),
    sleep: jest.fn(async (ms) => { t += ms; }),
    now: () => t,
    ...overrides,
  };
}

describe('startStripeCheckout', () => {
  it('opens Checkout with the return scheme, syncs and unlocks', async () => {
    const d = deps();
    const r = await startStripeCheckout({ interval: 'year', seats: 7 }, d);
    expect(d.api.createCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 7 });
    expect(d.openAuthSession).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1', RETURN_URL);
    expect(d.api.syncCheckout).toHaveBeenCalledWith('cs_test_1');
    expect(r.outcome).toBe('unlocked');
  });

  it.each(['cancel', 'dismiss'])('always syncs, even when the browser reports %s (T3, Android)', async (type) => {
    const d = deps({ openAuthSession: jest.fn(async () => ({ type })) });
    await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(d.api.syncCheckout).toHaveBeenCalledWith('cs_test_1');
  });

  it('polls every 2 s for up to 30 s while processing, then reports confirming (T4)', async () => {
    const d = deps({
      api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } })) },
      refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })),
    });
    const r = await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(r.outcome).toBe('confirming');
    expect(d.sleep).toHaveBeenCalledWith(2000);
    expect(d.refreshStatus.mock.calls.length).toBeGreaterThanOrEqual(15);
    expect(d.refreshStatus.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it('stops polling as soon as entitlement arrives', async () => {
    const refreshStatus = jest.fn().mockResolvedValueOnce({ entitlement: { allowed: false } }).mockResolvedValueOnce({ entitlement: { allowed: true } });
    const d = deps({ api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } })) }, refreshStatus });
    expect((await startStripeCheckout({ interval: 'month', seats: 5 }, d)).outcome).toBe('unlocked');
    expect(refreshStatus).toHaveBeenCalledTimes(2);
  });

  it('reports not_completed after a cancelled checkout', async () => {
    const d = deps({
      openAuthSession: jest.fn(async () => ({ type: 'cancel' })),
      api: { ...deps().api, syncCheckout: jest.fn(async () => ({ entitlement: { allowed: false }, pendingCheckout: { state: 'open' } })) },
      refreshStatus: jest.fn(async () => ({ entitlement: { allowed: false } })),
    });
    expect((await startStripeCheckout({ interval: 'month', seats: 5 }, d)).outcome).toBe('not_completed');
  });

  it('turns API errors into an error outcome without throwing', async () => {
    const err = { response: { status: 409, data: { code: 'PAYMENT_ISSUE', portalUrl: 'https://billing.stripe.com/p/x' } } };
    const d = deps({ api: { ...deps().api, createCheckout: jest.fn(async () => { throw err; }) } });
    const r = await startStripeCheckout({ interval: 'month', seats: 5 }, d);
    expect(r).toMatchObject({ outcome: 'error', error: { portalUrl: 'https://billing.stripe.com/p/x' } });
  });
});

describe('describeCheckoutError', () => {
  it.each([
    ['ALREADY_SUBSCRIBED', /already/i], ['PAYMENT_ISSUE', /payment/i], ['SEATS_BELOW_MEMBERS', /members/i],
    ['PURCHASE_METHOD_MISMATCH', /isn't available here/i], ['BILLING_MODE_UNAVAILABLE', /isn't available/i], ['LOCK_BUSY', /moment/i],
  ])('%s', (code, re) => {
    expect(describeCheckoutError({ response: { data: { code, memberCount: 7 } } }).message).toMatch(re);
  });

  it('falls back for network errors', () => {
    expect(describeCheckoutError(new Error('Network Error')).message).toMatch(/connection/i);
  });
});

describe('openBillingPortal', () => {
  it('opens the portal with the return scheme then refreshes', async () => {
    const d = deps();
    await openBillingPortal(d);
    expect(d.openAuthSession).toHaveBeenCalledWith('https://billing.stripe.com/p/session/x', RETURN_URL);
    expect(d.refreshStatus).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/shared/billing/__tests__/purchase.test.js` → FAIL.

- [ ] **Step 3: Implement**

`mobile/src/shared/billing/legalLinks.js`:
```js
// Confirm both URLs with the owner before release (orchestrator item in Wave 9 gate).
export const TERMS_URL = 'https://rootaroo.com/terms';
export const PRIVACY_URL = 'https://rootaroo.com/privacy';

export const STORE_SUBSCRIPTION_URLS = {
  apple: 'https://apps.apple.com/account/subscriptions',
  google: 'https://play.google.com/store/account/subscriptions?package=com.rootaroo.app',
};
```

`mobile/src/shared/billing/purchase.js`:
```js
import * as WebBrowser from 'expo-web-browser';
import { billingApi } from '../api/billing';
import { useBillingStore } from '../store/billingStore';

export const RETURN_URL = 'rootaroo://billing';
const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 30000;

export const defaultDeps = {
  api: billingApi,
  openAuthSession: (url, returnUrl) => WebBrowser.openAuthSessionAsync(url, returnUrl),
  openBrowser: (url) => WebBrowser.openBrowserAsync(url),
  refreshStatus: () => useBillingStore.getState().refresh(),
  applySync: (sync) => useBillingStore.getState().applySync(sync),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function pollUntilSettled(deps, timeoutMs = POLL_FOR_MS, everyMs = POLL_EVERY_MS) {
  const end = deps.now() + timeoutMs;
  let last = null;
  while (deps.now() < end) {
    last = await deps.refreshStatus();
    if (last?.entitlement?.allowed) return last;
    await deps.sleep(everyMs);
  }
  return last;
}

/**
 * §8.2: open hosted Checkout, then ALWAYS sync by sessionId, whatever the browser
 * reported (Android often says "dismiss" after a successful payment).
 */
export async function startStripeCheckout({ interval, seats }, deps = defaultDeps) {
  let created;
  try {
    created = await deps.api.createCheckout({ interval, seats });
  } catch (err) {
    return { outcome: 'error', status: null, error: describeCheckoutError(err) };
  }
  let result = { type: 'dismiss' };
  try {
    result = await deps.openAuthSession(created.url, RETURN_URL);
  } catch {
    /* treat as dismiss; the sync below decides */
  }
  let sync = null;
  try {
    sync = await deps.api.syncCheckout(created.sessionId);
    deps.applySync(sync);
  } catch {
    /* the webhook or the 15-minute sweep will catch up (T3) */
  }
  if (sync?.entitlement?.allowed) return { outcome: 'unlocked', status: await deps.refreshStatus() };
  if (sync?.pendingCheckout?.state === 'processing') {
    const status = await pollUntilSettled(deps);
    return { outcome: status?.entitlement?.allowed ? 'unlocked' : 'confirming', status };
  }
  const status = await deps.refreshStatus();
  if (status?.entitlement?.allowed) return { outcome: 'unlocked', status };
  return { outcome: result.type === 'success' ? 'confirming' : 'not_completed', status };
}

export async function openBillingPortal(deps = defaultDeps) {
  const { url } = await deps.api.openPortal();
  try { await deps.openAuthSession(url, RETURN_URL); } catch { /* ignore */ }
  return deps.refreshStatus();
}

export function describeCheckoutError(err) {
  const data = err?.response?.data || {};
  switch (data.code) {
    case 'ALREADY_SUBSCRIBED':
      return { title: 'Already subscribed', message: 'Your household already has a subscription. Pull to refresh.' };
    case 'PAYMENT_ISSUE':
      return { title: 'Payment problem', message: 'Your last payment failed. Update your payment method to continue.', portalUrl: data.portalUrl || null };
    case 'SEATS_BELOW_MEMBERS':
      return { title: 'Choose a bigger plan', message: `Your household has ${data.memberCount} members. Choose a plan with at least that many.` };
    case 'PURCHASE_METHOD_MISMATCH':
      return { title: 'Not available', message: "Purchasing isn't available here yet." };
    case 'BILLING_MODE_UNAVAILABLE':
      return { title: 'Not available', message: "Purchasing isn't available right now. Please try again later." };
    case 'LOCK_BUSY':
      return { title: 'One moment', message: 'Another purchase is in progress. Try again in a moment.' };
    default:
      return { title: 'Something went wrong', message: err?.response ? 'Please try again.' : 'Check your connection and try again.' };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest src/shared/billing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/shared/billing
git commit -F - <<'MSG'
feat(mobile-billing): checkout flow helper that always syncs and polls while processing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.4: Paywall screens, grace banner and `RootNavigator` gating

**Files:**
- Create: `mobile/src/screens/billing/PaywallScreen.jsx`, `mobile/src/screens/billing/PaywallMemberScreen.jsx`, `mobile/src/screens/billing/components/PlanPicker.jsx`, `mobile/src/screens/billing/components/GraceBanner.jsx`, `mobile/src/shared/hooks/useBillingLifecycle.js`, `mobile/src/shared/billing/gate.js`
- Modify: `mobile/src/navigation/RootNavigator.js`
- Test: `mobile/src/screens/billing/__tests__/PaywallScreen.test.js`, `mobile/src/screens/billing/__tests__/PaywallMemberScreen.test.js`, `mobile/src/shared/billing/__tests__/gate.test.js`

**Interfaces:**
- Consumes: `useBillingStore`, `selectGate` (9.1); `seatRange`, `planAmount`, `formatCents`, `autoRenewDisclosure` (9.2); `startStripeCheckout`, `openBillingPortal`, `describeCheckoutError` (9.3); `TERMS_URL`, `PRIVACY_URL` (9.3).
- Produces: `chooseRootView({ isAuthenticated, gate }): 'auth' | 'paywall' | 'main'`; `useBillingLifecycle(isAuthenticated, userId)`; `<PlanPicker plans interval seats range onChange />`; `<GraceBanner />`; screens `Paywall`, `PaywallMember`.

- [ ] **Step 1: Write the failing tests**

`mobile/src/shared/billing/__tests__/gate.test.js`:
```js
import { chooseRootView } from '../gate';

describe('chooseRootView (§7.4)', () => {
  it.each([
    [false, 'blocked', 'auth'], [true, 'blocked', 'paywall'], [true, 'allowed', 'main'],
    [true, 'grace', 'main'], [true, 'unknown', 'main'],
  ])('auth=%s gate=%s -> %s', (isAuthenticated, gate, view) => expect(chooseRootView({ isAuthenticated, gate })).toBe(view));
});
```

`mobile/src/screens/billing/__tests__/PaywallScreen.test.js`:
```js
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../shared/billing/purchase', () => ({
  startStripeCheckout: jest.fn(async () => ({ outcome: 'unlocked' })),
  openBillingPortal: jest.fn(),
  describeCheckoutError: jest.requireActual('../../../shared/billing/purchase').describeCheckoutError,
}));
jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn() } }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({ logout: jest.fn() }) } }));

const { startStripeCheckout } = require('../../../shared/billing/purchase');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const PaywallScreen = require('../PaywallScreen').default;

const setStatus = (o) => useBillingStore.setState({ status: statusFixture(o) });

describe('PaywallScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the yearly total and the auto-renewal disclosure next to Subscribe', () => {
    setStatus();
    const { getByText } = render(<PaywallScreen />);
    expect(getByText('$79.99')).toBeTruthy();
    expect(getByText('Renews automatically at $79.99 per year until cancelled. Cancel anytime in Manage subscription.')).toBeTruthy();
  });

  it('stepper starts at the member count and cannot go below it', () => {
    setStatus({ memberCount: 7 });
    const { getByLabelText, getByText } = render(<PaywallScreen />);
    expect(getByText('7')).toBeTruthy();
    fireEvent.press(getByLabelText('Remove a member'));
    expect(getByText('7')).toBeTruthy();
    fireEvent.press(getByLabelText('Monthly'));
    expect(getByText('$12.97')).toBeTruthy();
  });

  it('subscribes with the chosen plan', async () => {
    setStatus();
    const { getByLabelText, getByText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Add a member'));
    fireEvent.press(getByText(/^Subscribe/));
    await waitFor(() => expect(startStripeCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 6 }));
  });

  it('explains over-cap households and disables Subscribe (Review Focus 3)', () => {
    setStatus({ memberCount: 11 });
    const { getByText, getByLabelText } = render(<PaywallScreen />);
    expect(getByText(/11 members.*largest plan is 10/)).toBeTruthy();
    expect(getByLabelText('Subscribe').props.accessibilityState.disabled).toBe(true);
  });

  it('shows "Purchasing isn\'t available here yet" for an unsupported method', () => {
    setStatus({ purchaseMethod: 'apple_iap' });
    expect(render(<PaywallScreen />).getByText("Purchasing isn't available here yet")).toBeTruthy();
  });

  it('shows Confirming while a payment is processing', async () => {
    startStripeCheckout.mockResolvedValueOnce({ outcome: 'confirming' });
    setStatus();
    const { getByText, findByText } = render(<PaywallScreen />);
    fireEvent.press(getByText(/^Subscribe/));
    expect(await findByText('Confirming your payment…')).toBeTruthy();
  });
});
```

`mobile/src/screens/billing/__tests__/PaywallMemberScreen.test.js`:
```js
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(async () => ({})) } }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({ logout: jest.fn() }) } }));

const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const PaywallMemberScreen = require('../PaywallMemberScreen').default;

describe('PaywallMemberScreen', () => {
  it('asks the admins to renew and retries', () => {
    const refresh = jest.fn();
    useBillingStore.setState({ status: statusFixture({ isAdmin: false, adminNames: ['Asha', 'Ravi'] }), refresh });
    const { getByText } = render(<PaywallMemberScreen />);
    expect(getByText('Ask Asha or Ravi to renew Rootaroo')).toBeTruthy();
    fireEvent.press(getByText('Retry'));
    expect(refresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd mobile && npx jest src/screens/billing src/shared/billing/__tests__/gate.test.js` → FAIL.

- [ ] **Step 3: Implement**

`mobile/src/shared/billing/gate.js`:
```js
/** §7.4: a signed-in member whose entitlement is not allowed gets the paywall. Unknown (first launch, offline) is not blocked: the server's 402 decides. */
export function chooseRootView({ isAuthenticated, gate }) {
  if (!isAuthenticated) return 'auth';
  return gate === 'blocked' ? 'paywall' : 'main';
}
```

`mobile/src/shared/hooks/useBillingLifecycle.js`:
```js
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useBillingStore } from '../store/billingStore';

/** §7.4: status on launch and on every return to the foreground. */
export function useBillingLifecycle(isAuthenticated, userId) {
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    const store = useBillingStore.getState();
    store.hydrate(userId).then(() => useBillingStore.getState().refresh());
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') useBillingStore.getState().refresh();
    });
    return () => sub.remove();
  }, [isAuthenticated]);
}
```

`mobile/src/screens/billing/components/PlanPicker.jsx`:
```jsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { planAmount, formatCents, autoRenewDisclosure } from '../../../shared/billing/pricing';
import { colors, fonts, withAlpha } from '../../../shared/theme';

export default function PlanPicker({ plans, interval, seats, range, onChange }) {
  const cents = planAmount(plans, interval, Math.min(seats, plans.seatsMax));
  return (
    <View>
      <View style={styles.tabs}>
        {[['year', 'Yearly'], ['month', 'Monthly']].map(([value, label]) => (
          <TouchableOpacity
            key={value}
            style={[styles.tab, interval === value && styles.tabOn]}
            onPress={() => onChange({ interval: value, seats })}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: interval === value }}
          >
            <Text style={[styles.tabText, interval === value && styles.tabTextOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Household size</Text>
        <View style={styles.stepper}>
          <TouchableOpacity
            style={styles.step}
            disabled={seats <= range.min}
            onPress={() => onChange({ interval, seats: Math.max(range.min, seats - 1) })}
            accessibilityRole="button"
            accessibilityLabel="Remove a member"
          >
            <Text style={styles.stepText}>−</Text>
          </TouchableOpacity>
          <Text style={styles.seats}>{seats}</Text>
          <TouchableOpacity
            style={styles.step}
            disabled={seats >= range.max}
            onPress={() => onChange({ interval, seats: Math.min(range.max, seats + 1) })}
            accessibilityRole="button"
            accessibilityLabel="Add a member"
          >
            <Text style={styles.stepText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.total}>{formatCents(cents)}</Text>
      <Text style={styles.per}>per {interval}</Text>
      <Text style={styles.disclosure}>{autoRenewDisclosure(cents, interval)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 6, padding: 4, borderRadius: 99, backgroundColor: colors.canvasGray },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 99, alignItems: 'center' },
  tabOn: { backgroundColor: colors.gold },
  tabText: { fontFamily: fonts.bodyBold, color: colors.textSecondary, fontWeight: '800' },
  tabTextOn: { color: colors.canvas },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  label: { fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 15 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  step: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: withAlpha(colors.white, 0.15), alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.ink, fontSize: 18 },
  seats: { fontFamily: fonts.mono, color: colors.ink, fontSize: 18, minWidth: 26, textAlign: 'center' },
  total: { fontFamily: fonts.mono, color: colors.ink, fontSize: 40, fontWeight: '800', marginTop: 24 },
  per: { fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  disclosure: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, fontSize: 12, marginTop: 12 },
});
```

`mobile/src/screens/billing/PaywallScreen.jsx`:
```jsx
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useBillingStore } from '../../shared/store/billingStore';
import { useAuthStore } from '../../shared/store/authStore';
import { seatRange } from '../../shared/billing/pricing';
import { startStripeCheckout, openBillingPortal } from '../../shared/billing/purchase';
import { TERMS_URL, PRIVACY_URL } from '../../shared/billing/legalLinks';
import PlanPicker from './components/PlanPicker';
import { colors, fonts } from '../../shared/theme';

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const status = useBillingStore((s) => s.status);
  const plans = status?.plans;
  const range = plans ? seatRange(plans, status.memberCount) : { min: 5, max: 10, overCap: false };
  const [choice, setChoice] = useState({ interval: 'year', seats: Math.min(range.min, range.max) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const supported = status?.purchaseMethod === 'stripe_checkout';
  const canBuy = supported && plans && !range.overCap && !busy;

  const subscribe = async () => {
    setBusy(true);
    setMessage(null);
    const r = await startStripeCheckout(choice);
    setBusy(false);
    if (r.outcome === 'confirming') setMessage({ text: 'Confirming your payment…' });
    else if (r.outcome === 'not_completed') setMessage({ text: 'Checkout was not completed.' });
    else if (r.outcome === 'error') setMessage({ text: r.error.message, portalUrl: r.error.portalUrl });
    // 'unlocked': the store flips the gate and RootNavigator shows MainTabs.
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, paddingHorizontal: 22 }}>
      <Text style={styles.title}>Keep your household together</Text>
      <Text style={styles.sub}>Rootaroo needs an active subscription. Your data is safe and waiting.</Text>

      {!plans ? <ActivityIndicator color={colors.gold} style={{ marginTop: 40 }} /> : (
        <View style={{ marginTop: 24 }}>
          {range.overCap ? (
            <Text style={styles.warn}>{`Your household has ${status.memberCount} members, and the largest plan is 10. Remove members in Household settings to subscribe.`}</Text>
          ) : (
            <PlanPicker plans={plans} interval={choice.interval} seats={choice.seats} range={range} onChange={setChoice} />
          )}
        </View>
      )}

      {!supported && status ? <Text style={styles.warn}>Purchasing isn't available here yet</Text> : null}

      <TouchableOpacity
        style={[styles.cta, !canBuy && styles.ctaOff]}
        disabled={!canBuy}
        onPress={subscribe}
        accessibilityRole="button"
        accessibilityLabel="Subscribe"
        accessibilityState={{ disabled: !canBuy }}
      >
        {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.ctaText}>Subscribe</Text>}
      </TouchableOpacity>

      {message ? <Text style={styles.message}>{message.text}</Text> : null}
      {message?.portalUrl ? (
        <TouchableOpacity onPress={() => openBillingPortal()}><Text style={styles.link}>Update payment method</Text></TouchableOpacity>
      ) : null}

      <TouchableOpacity onPress={() => useBillingStore.getState().refresh()}><Text style={styles.link}>Restore purchases</Text></TouchableOpacity>
      <View style={styles.legal}>
        <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(TERMS_URL)}><Text style={styles.small}>Terms</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)}><Text style={styles.small}>Privacy</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => useAuthStore.getState().logout()}><Text style={styles.small}>Sign out</Text></TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 26, fontWeight: '800' },
  sub: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 8 },
  warn: { fontFamily: fonts.bodySemiBold, color: colors.danger, marginTop: 16 },
  cta: { marginTop: 24, backgroundColor: colors.gold, borderRadius: 99, paddingVertical: 15, alignItems: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.canvas, fontSize: 16, fontWeight: '800' },
  message: { fontFamily: fonts.bodySemiBold, color: colors.ink, marginTop: 14, textAlign: 'center' },
  link: { fontFamily: fonts.bodyBold, color: colors.gold, marginTop: 16, textAlign: 'center' },
  legal: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 24 },
  small: { fontFamily: fonts.bodySemiBold, color: colors.textMuted, fontSize: 12 },
});
```
Note: the yearly total rendered by `PlanPicker` is `formatCents` (`$79.99`), which is what the test queries.

`mobile/src/screens/billing/PaywallMemberScreen.jsx`:
```jsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBillingStore } from '../../shared/store/billingStore';
import { useAuthStore } from '../../shared/store/authStore';
import { colors, fonts } from '../../shared/theme';

export default function PaywallMemberScreen() {
  const insets = useSafeAreaInsets();
  const admins = useBillingStore((s) => s.status?.adminNames ?? []);
  const refresh = useBillingStore((s) => s.refresh);
  const who = admins.length > 0 ? admins.join(' or ') : 'your household admin';
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 60 }]}>
      <Text style={styles.title}>{`Ask ${who} to renew Rootaroo`}</Text>
      <Text style={styles.sub}>Your household's subscription has ended. Everything is saved and comes back as soon as it's renewed.</Text>
      <TouchableOpacity style={styles.cta} onPress={() => refresh()} accessibilityRole="button">
        <Text style={styles.ctaText}>Retry</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => useAuthStore.getState().logout()}><Text style={styles.link}>Sign out</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 24 },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 24, fontWeight: '800' },
  sub: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 12 },
  cta: { marginTop: 32, backgroundColor: colors.gold, borderRadius: 99, paddingVertical: 15, alignItems: 'center' },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.canvas, fontSize: 16, fontWeight: '800' },
  link: { fontFamily: fonts.bodyBold, color: colors.textMuted, marginTop: 20, textAlign: 'center' },
});
```

`mobile/src/screens/billing/components/GraceBanner.jsx`:
```jsx
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBillingStore, selectGate } from '../../../shared/store/billingStore';
import { openBillingPortal } from '../../../shared/billing/purchase';
import { colors, fonts } from '../../../shared/theme';

/** §7.4: shown over MainTabs while a failed renewal is in its grace period. */
export default function GraceBanner() {
  const insets = useSafeAreaInsets();
  const gate = useBillingStore(selectGate);
  const status = useBillingStore((s) => s.status);
  const [hidden, setHidden] = useState(false);
  if (gate !== 'grace' || hidden) return null;
  const until = status?.entitlement?.graceUntil ? new Date(status.entitlement.graceUntil).toLocaleDateString() : 'soon';
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 6 }]} accessibilityRole="alert">
      <Text style={styles.text}>{`Payment failed. Access ends ${until}.`}</Text>
      {status?.isAdmin ? (
        <TouchableOpacity onPress={() => openBillingPortal()} accessibilityRole="button"><Text style={styles.action}>Fix payment</Text></TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={() => setHidden(true)} accessibilityLabel="Hide"><Text style={styles.close}>×</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: colors.danger },
  text: { flex: 1, fontFamily: fonts.bodyBold, color: colors.white, fontSize: 13 },
  action: { fontFamily: fonts.bodyBold, color: colors.white, textDecorationLine: 'underline' },
  close: { color: colors.white, fontSize: 20 },
});
```

`RootNavigator.js`:
- imports: `useBillingStore, selectGate` from `'../shared/store/billingStore'`; `useBillingLifecycle` from `'../shared/hooks/useBillingLifecycle'`; `chooseRootView` from `'../shared/billing/gate'`; `PaywallScreen`, `PaywallMemberScreen`, `GraceBanner`, `SubscriptionScreen` (Task 9.5 adds the last one; import it there).
- add next to the other navigators:
```jsx
const PaywallStack = createNativeStackNavigator();

function PaywallNavigator() {
  const isAdmin = useBillingStore((s) => s.status?.isAdmin);
  return (
    <PaywallStack.Navigator screenOptions={{ headerShown: false }}>
      {isAdmin
        ? <PaywallStack.Screen name="Paywall" component={PaywallScreen} />
        : <PaywallStack.Screen name="PaywallMember" component={PaywallMemberScreen} />}
    </PaywallStack.Navigator>
  );
}

function MainWithBanner(props) {
  return (
    <View style={{ flex: 1 }}>
      <MainNavigator {...props} />
      <GraceBanner />
    </View>
  );
}
```
- in `RootNavigator()`: after the existing hooks add
```jsx
  const userId = useAuthStore((s) => s.user?.id);
  useBillingLifecycle(isAuthenticated, userId);
  const gate = useBillingStore(selectGate);
```
- replace `if (!isAuthenticated) { return <AuthNavigator />; }` with:
```jsx
  const view = chooseRootView({ isAuthenticated, gate });
  if (view === 'auth') return <AuthNavigator />;
  if (view === 'paywall') return <PaywallNavigator />;
```
- change the MainTabs screen to `component={MainWithBanner}`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd mobile && npx jest`
Expected: PASS (all mobile suites).

- [ ] **Step 5: Commit**

```bash
git add mobile/src
git commit -F - <<'MSG'
feat(mobile-billing): paywall screens, grace banner and entitlement gating in RootNavigator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.5: Subscription screen (More → Household → Subscription)

**Files:**
- Create: `mobile/src/screens/billing/SubscriptionScreen.jsx`
- Modify: `mobile/src/screens/MoreScreen.jsx` (Household section row), `mobile/src/navigation/RootNavigator.js` (`MoreNav.Screen name="Subscription"`)
- Test: `mobile/src/screens/billing/__tests__/SubscriptionScreen.test.js`

**Interfaces:**
- Consumes: `billingApi.changePlan` (9.1), `openBillingPortal` (9.3), `PlanPicker` (9.4), `STORE_SUBSCRIPTION_URLS` (9.3).
- Produces: screen `Subscription` showing plan, renewal/end date, price paid, seats used/allowed, provider; admin actions Manage subscription / Change plan (Stripe only) / Restore purchases.

- [ ] **Step 1: Write the failing test**

`mobile/src/screens/billing/__tests__/SubscriptionScreen.test.js`:
```js
import React from 'react';
import { Linking } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';

jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(), changePlan: jest.fn() } }));
jest.mock('../../../shared/billing/purchase', () => ({ openBillingPortal: jest.fn() }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({}) } }));

const { billingApi } = require('../../../shared/api/billing');
const { openBillingPortal } = require('../../../shared/billing/purchase');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const SubscriptionScreen = require('../SubscriptionScreen').default;

const active = (o = {}) => statusFixture({
  entitlement: { allowed: true, reason: 'active', seatsAllowed: 6 },
  subscription: { provider: 'stripe', status: 'active', interval: 'month', seats: 6, unitAmount: 1098, currency: 'usd', priceSet: '2026-10', currentPeriodEnd: '2026-11-02T00:00:00.000Z', cancelAtPeriodEnd: false, graceUntil: null, pendingUpdate: false },
  memberCount: 4, ...o,
});

describe('SubscriptionScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows plan, price paid, renewal and seats', () => {
    useBillingStore.setState({ status: active() });
    const { getByText } = render(<SubscriptionScreen />);
    expect(getByText('6 members · monthly')).toBeTruthy();
    expect(getByText('$10.98 per month')).toBeTruthy();
    expect(getByText(/Renews on/)).toBeTruthy();
    expect(getByText('4 of 6 seats used')).toBeTruthy();
    expect(getByText('Paid with card (Stripe)')).toBeTruthy();
  });

  it('shows "Ends on" when cancelling at period end', () => {
    useBillingStore.setState({ status: active({ subscription: { ...active().subscription, cancelAtPeriodEnd: true } }) });
    expect(render(<SubscriptionScreen />).getByText(/Ends on/)).toBeTruthy();
  });

  it('Manage subscription opens the Stripe portal', () => {
    useBillingStore.setState({ status: active() });
    fireEvent.press(render(<SubscriptionScreen />).getByText('Manage subscription'));
    expect(openBillingPortal).toHaveBeenCalled();
  });

  it('Manage subscription opens the store page for IAP providers and hides Change plan', () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    useBillingStore.setState({ status: active({ subscription: { ...active().subscription, provider: 'apple' } }) });
    const { getByText, queryByText } = render(<SubscriptionScreen />);
    fireEvent.press(getByText('Manage subscription'));
    expect(spy).toHaveBeenCalledWith('https://apps.apple.com/account/subscriptions');
    expect(queryByText('Change plan')).toBeNull();
  });

  it('changes plan and opens the hosted invoice when payment needs action (T8)', async () => {
    useBillingStore.setState({ status: active(), refresh: jest.fn() });
    billingApi.changePlan.mockResolvedValue({ changed: true, pendingUpdate: true, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
    const { getByText, getByLabelText } = render(<SubscriptionScreen />);
    fireEvent.press(getByText('Change plan'));
    fireEvent.press(getByLabelText('Add a member'));
    fireEvent.press(getByText('Confirm change'));
    await waitFor(() => expect(billingApi.changePlan).toHaveBeenCalledWith({ interval: 'month', seats: 7 }));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://invoice.stripe.com/i/x');
  });

  it('members see the plan but no actions', () => {
    useBillingStore.setState({ status: active({ isAdmin: false }) });
    const { queryByText } = render(<SubscriptionScreen />);
    expect(queryByText('Manage subscription')).toBeNull();
    expect(queryByText('Change plan')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/screens/billing/__tests__/SubscriptionScreen.test.js` → FAIL.

- [ ] **Step 3: Implement**

`mobile/src/screens/billing/SubscriptionScreen.jsx`:
```jsx
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useBillingStore } from '../../shared/store/billingStore';
import { billingApi } from '../../shared/api/billing';
import { openBillingPortal, describeCheckoutError } from '../../shared/billing/purchase';
import { formatCents, seatRange } from '../../shared/billing/pricing';
import { STORE_SUBSCRIPTION_URLS } from '../../shared/billing/legalLinks';
import PlanPicker from './components/PlanPicker';
import { colors, fonts } from '../../shared/theme';

const PROVIDER_LABEL = { stripe: 'Paid with card (Stripe)', apple: 'Paid through the App Store', google: 'Paid through Google Play' };

export default function SubscriptionScreen() {
  const insets = useSafeAreaInsets();
  const status = useBillingStore((s) => s.status);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const sub = status?.subscription;
  const plans = status?.plans;
  const range = plans ? seatRange(plans, status.memberCount) : null;
  const [choice, setChoice] = useState(sub ? { interval: sub.interval, seats: sub.seats } : { interval: 'year', seats: 5 });

  if (!status) return <ActivityIndicator style={{ marginTop: 80 }} color={colors.gold} />;

  const manage = () => {
    if (!sub || sub.provider === 'stripe') return openBillingPortal();
    return Linking.openURL(STORE_SUBSCRIPTION_URLS[sub.provider === 'apple' ? 'apple' : 'google']);
  };

  const confirmChange = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await billingApi.changePlan(choice);
      if (r.pendingUpdate && r.hostedInvoiceUrl) {
        setMessage('Confirm the payment to finish your plan change.');
        await WebBrowser.openBrowserAsync(r.hostedInvoiceUrl);
      } else {
        setMessage(r.changed ? 'Your plan was updated.' : 'That is already your plan.');
      }
      setEditing(false);
      await useBillingStore.getState().refresh();
    } catch (err) {
      setMessage(describeCheckoutError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const date = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : null;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32, paddingHorizontal: 20 }}>
      <Text style={styles.title}>Subscription</Text>
      {sub ? (
        <View style={styles.card}>
          <Text style={styles.big}>{`${sub.seats} members · ${sub.interval === 'year' ? 'yearly' : 'monthly'}`}</Text>
          {sub.unitAmount !== null ? <Text style={styles.line}>{`${formatCents(sub.unitAmount)} per ${sub.interval}`}</Text> : null}
          {date ? <Text style={styles.line}>{sub.cancelAtPeriodEnd ? `Ends on ${date}` : `Renews on ${date}`}</Text> : null}
          <Text style={styles.line}>{`${status.memberCount} of ${status.entitlement.seatsAllowed} seats used`}</Text>
          <Text style={styles.muted}>{PROVIDER_LABEL[sub.provider] ?? sub.provider}</Text>
          {sub.pendingUpdate ? <Text style={styles.warn}>A plan change is waiting for payment.</Text> : null}
        </View>
      ) : (
        <Text style={styles.line}>{status.entitlement.reason === 'test_cohort' ? 'Test household: no subscription needed.' : 'No subscription yet.'}</Text>
      )}

      {status.isAdmin ? (
        <View style={{ marginTop: 20 }}>
          {sub ? <Action label="Manage subscription" onPress={manage} /> : null}
          {sub?.provider === 'stripe' && plans && !editing ? <Action label="Change plan" onPress={() => setEditing(true)} /> : null}
          {editing && plans ? (
            <View style={styles.card}>
              <PlanPicker plans={plans} interval={choice.interval} seats={choice.seats} range={range} onChange={setChoice} />
              <Action label={busy ? 'Saving…' : 'Confirm change'} onPress={confirmChange} disabled={busy} />
              <Action label="Cancel" onPress={() => setEditing(false)} />
            </View>
          ) : null}
          <Action label="Restore purchases" onPress={() => useBillingStore.getState().refresh()} />
        </View>
      ) : null}
      {message ? <Text style={styles.line}>{message}</Text> : null}
    </ScrollView>
  );
}

function Action({ label, onPress, disabled }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} disabled={disabled} accessibilityRole="button">
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 26, fontWeight: '800', marginBottom: 16 },
  card: { backgroundColor: colors.canvasGray, borderRadius: 18, padding: 18, marginTop: 8 },
  big: { fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 18, fontWeight: '800' },
  line: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 8 },
  muted: { fontFamily: fonts.bodySemiBold, color: colors.textMuted, marginTop: 8, fontSize: 12 },
  warn: { fontFamily: fonts.bodySemiBold, color: colors.danger, marginTop: 8 },
  action: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.canvasGray },
  actionText: { fontFamily: fonts.bodyBold, color: colors.gold, fontSize: 15 },
});
```

`MoreScreen.jsx`: in the `Household` section's rows, directly after the `Household settings` row, add a row in the same shape as its siblings:
```jsx
        {
          label: 'Subscription',
          onPress: go('Subscription'),
        },
```
(If sibling rows carry an `icon` key, give this one the same kind of icon the file already uses for settings rows, e.g. `'card-outline'` for Ionicons.)

`RootNavigator.js`: `import SubscriptionScreen from '../screens/billing/SubscriptionScreen';` and in the More stack after `HouseholdSettings`: `<MoreNav.Screen name="Subscription" component={SubscriptionScreen} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src
git commit -F - <<'MSG'
feat(mobile-billing): subscription screen with portal, plan change and store links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.6: Onboarding purchase on `FeaturePricingScreen` (§7.4 Onboarding)

**Files:**
- Modify: `mobile/src/screens/onboarding/FeaturePricingScreen.jsx`
- Test: `mobile/src/screens/onboarding/__tests__/FeaturePricingScreen.test.js`

**Interfaces:**
- Consumes: `startStripeCheckout` (9.3), `useBillingStore` (9.1), `derivePricing` (9.2), `autoRenewDisclosure` (9.2).
- Produces: CTA `Subscribe · $X` starts the routed purchase flow; `finish()` runs on `unlocked` or on **Not now**.

- [ ] **Step 1: Write the failing test**

`mobile/src/screens/onboarding/__tests__/FeaturePricingScreen.test.js`:
```js
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../shared/billing/purchase', () => ({ startStripeCheckout: jest.fn() }));
jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(async () => ({})) } }));
const completeSetup = jest.fn();
jest.mock('../../../shared/store/authStore', () => ({
  useAuthStore: { getState: () => ({ triggerCelebration: jest.fn(), triggerTour: jest.fn(), completeSetup }) },
}));
jest.mock('../../../shared/store/signupProgress', () => ({ updateSignupProgress: jest.fn(async () => {}) }));
jest.mock('@react-navigation/native', () => ({ ...jest.requireActual('@react-navigation/native'), useIsFocused: () => true }));
jest.mock('../FeatureTourShell', () => {
  const { Text, View, TouchableOpacity } = require('react-native');
  return ({ ctaLabel, onContinue, children }) => (
    <View>{children}<TouchableOpacity onPress={onContinue}><Text>{ctaLabel}</Text></TouchableOpacity></View>
  );
});

const { startStripeCheckout } = require('../../../shared/billing/purchase');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const FeaturePricingScreen = require('../FeaturePricingScreen').default;

describe('FeaturePricingScreen purchase', () => {
  beforeEach(() => { jest.clearAllMocks(); useBillingStore.setState({ status: statusFixture(), refresh: jest.fn() }); });

  it('subscribes with the selected plan and finishes when unlocked', async () => {
    startStripeCheckout.mockResolvedValue({ outcome: 'unlocked' });
    const { getByText } = render(<FeaturePricingScreen navigation={{}} />);
    fireEvent.press(getByText('Subscribe · $79.99/yr'));
    await waitFor(() => expect(startStripeCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 5 }));
    await waitFor(() => expect(completeSetup).toHaveBeenCalled());
  });

  it('stays on screen while confirming, and "Not now" finishes', async () => {
    startStripeCheckout.mockResolvedValue({ outcome: 'confirming' });
    const { getByText, findByText } = render(<FeaturePricingScreen navigation={{}} />);
    fireEvent.press(getByText('Subscribe · $79.99/yr'));
    expect(await findByText('Confirming your payment…')).toBeTruthy();
    expect(completeSetup).not.toHaveBeenCalled();
    fireEvent.press(getByText('Not now'));
    await waitFor(() => expect(completeSetup).toHaveBeenCalled());
  });

  it('shows the auto-renewal disclosure', () => {
    const { getByText } = render(<FeaturePricingScreen navigation={{}} />);
    expect(getByText('Renews automatically at $79.99 per year until cancelled. Cancel anytime in Manage subscription.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest src/screens/onboarding` → FAIL.

- [ ] **Step 3: Implement**

In `FeaturePricingScreen.jsx`:
- imports: `import { startStripeCheckout } from '../../shared/billing/purchase';` and add `autoRenewDisclosure` to the pricing import.
- state: `const [buying, setBuying] = useState(false); const [note, setNote] = useState(null);`
- add:
```jsx
  const purchase = async () => {
    if (buying) return;
    if (status?.purchaseMethod !== 'stripe_checkout') {
      setNote("Purchasing isn't available here yet. You can subscribe later from More → Subscription.");
      return;
    }
    setBuying(true);
    setNote(null);
    const r = await startStripeCheckout({ interval: plan, seats: Math.min(size, range.max) });
    setBuying(false);
    if (r.outcome === 'unlocked') { await finish(); return; }
    if (r.outcome === 'confirming') setNote('Confirming your payment…');
    else if (r.outcome === 'error') setNote(r.error.message);
    else setNote('Checkout was not completed.');
  };
```
- the shell: `ctaLabel={buying ? 'Opening checkout…' : p.payLabel}`, `ctaSubLabel={p.payFine}`, `onContinue={purchase}`.
- at the end of the controls `Animated.View`, add:
```jsx
        <Text style={styles.disclosure}>{autoRenewDisclosure(p.amountCents, plan)}</Text>
        {note ? <Text style={styles.note}>{note}</Text> : null}
        <TouchableOpacity onPress={finish} accessibilityRole="button" style={styles.notNow}>
          <Text style={styles.notNowText}>Not now</Text>
        </TouchableOpacity>
```
- styles:
```js
  disclosure: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textMuted, marginTop: 16 },
  note: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.ink, marginTop: 12, textAlign: 'center' },
  notNow: { alignSelf: 'center', marginTop: 14, padding: 8 },
  notNowText: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.textSecondary },
```
- update the header comment: the CTA now starts the routed purchase; `finish()` runs on confirmed entitlement or **Not now**, after which `RootNavigator` shows the paywall if the household is still blocked.

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/screens/onboarding
git commit -F - <<'MSG'
feat(mobile-billing): onboarding pricing screen starts the purchase with disclosure and Not now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Task 9.7: Android emulator verification (§13.4)

**Files:**
- Create: `docs/superpowers/evidence/w9-mobile/README.md` (+ screenshots `01-paywall.png` … `06-subscription.png`)
- Create: `docs/billing/ios-manual-checklist.md`

**Interfaces:** none (verification task).

- [ ] **Step 1: Build and run the dev client** (needs the Phase 0 scheme; a new dev build is required)

Ask the orchestrator to start: server `cd server && npm run dev`; `stripe listen --api-key "$STRIPE_TEST_SECRET_KEY" --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test`; Android emulator; then `cd mobile && npx expo run:android`. Confirm `adb shell am start -W -a android.intent.action.VIEW -d "rootaroo://billing/cancel" com.rootaroo.app` opens the app (scheme registered).

- [ ] **Step 2: Walk the flow and capture screenshots** (orchestrator drives the emulator; card `4242 4242 4242 4242`, any future expiry, any CVC)

1. Fresh household admin finishes onboarding → `FeaturePricingScreen` shows server prices and the disclosure (screenshot 01).
2. **Not now** → paywall (02). Member account on another emulator user → `PaywallMemberScreen` with admin name (03).
3. Subscribe 6 members monthly → Checkout (04) → pay → returns to the app → MainTabs within 10 s.
4. Kill network, relaunch → still MainTabs (last-known status), then restore network.
5. More → Subscription shows `6 members · monthly`, `$10.98 per month`, renewal date, seats used (05); **Manage subscription** opens the portal (06).
6. Android back/dismiss during Checkout before paying → app shows "Checkout was not completed." and remains on the paywall.
Record results in `docs/superpowers/evidence/w9-mobile/README.md` (pass/fail per step, device/emulator image, build id).

- [ ] **Step 3: Write the iOS manual checklist**

`docs/billing/ios-manual-checklist.md`:
```markdown
# iOS manual checklist (real device, dev client) — Rootaroo billing Phase 1

Run on a physical iPhone with an EAS development build that includes the `rootaroo` scheme.

| # | Step | Expected | Pass |
|---|---|---|---|
| 1 | Open `rootaroo://billing/cancel` from Notes | App opens | |
| 2 | Onboarding pricing shows prices from the server and the auto-renewal disclosure | Matches `/billing/plans` | |
| 3 | Subscribe (4242…) in the auth session sheet | Sheet closes on success; MainTabs within 10 s | |
| 4 | Swipe the sheet away before paying | "Checkout was not completed."; paywall stays | |
| 5 | 3-D Secure card 4000 0025 0000 3155 | Challenge completes; app shows "Confirming…" then unlocks | |
| 6 | More → Subscription → Manage subscription | Stripe portal opens; return lands back in the app | |
| 7 | Background the app, cancel in portal on desktop, foreground the app | Subscription shows "Ends on <date>" | |
| 8 | Member account on a second device while the household is blocked | "Ask <admin> to renew Rootaroo" | |
| 9 | Grace period (staff planted via test clock) | Red banner with Fix payment for the admin | |
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/evidence/w9-mobile docs/billing/ios-manual-checklist.md
git commit -F - <<'MSG'
test(mobile-billing): Android emulator evidence and iOS manual checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0137SsiZB9jGBZhKS46dfsP6
MSG
```

### Wave 9 gate

Run:
```bash
cd mobile && npx jest
cd mobile && npx expo export --platform android --output-dir /tmp/rootaroo-export-check   # bundles without errors
cd .. && git grep -n "PRICE\b" -- mobile/src ; git grep -nE "sk_(test|live)_|rk_(test|live)_|pk_(test|live)_" -- mobile
cd server && npx jest && npm run test:int
```
Acceptance:
- All mobile and server suites green; the Android bundle exports.
- No `PRICE` constant and no Stripe key of any kind in `mobile/`.
- Task 9.7 evidence shows steps 1–6 passing.
- Orchestrator decision recorded: Terms/Privacy URLs in `legalLinks.js` confirmed by the owner.

---

## Wave 10: End-to-end against the Stripe dev sandbox (spec §13.3)

Executed by an implementer subagent plus the orchestrator (who completes hosted Checkout pages in Chrome). Everything runs on `rootaroo_impl` with `server/.env.impl` loaded, the dev server on port 3000, and `stripe listen --latest --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test` (its `whsec` kept only in `server/.env.impl`). `--latest` makes forwarded events use the same API version as production endpoints.

### Task 10.1: E2E harness (`server/scripts/e2e/`)
- `harness.ts`: seeds a fresh user, household and admin token through the real API (signup, then household create), with helpers `checkout(interval, seats)`, `status()`, `sync(sessionId)`, `planChange()`, `portal()`, `adminGet(path)`, `dbSnapshot(householdId)` (billing_* rows as JSON), `waitFor(predicate, timeoutMs)`.
- `lifecycle.ts`: lifecycle scenarios that don't need the hosted page. It creates a Stripe customer **with a test clock**, attaches `pm_card_visa` or `pm_card_chargeCustomerFail`, links the customer to the household through `billing_customers`, and creates the subscription through the API with `metadata {householdId, purchasedByUserId, env:'dev'}`. Our webhook, worker and `upsertSubscription` path is still exercised end to end. Advancing the test clock simulates renewals. Check test clock usage at docs.stripe.com/billing/testing/test-clocks.md.
- Each scenario writes its JSON results (API responses, DB snapshot, ledger rows, event types seen) to `docs/superpowers/evidence/e2e/<scenario>.json`. Never write keys or URLs that carry tokens.

### Task 10.2: Scenarios
| # | Scenario | Driver | Assertions |
|---|---|---|---|
| E1 | Checkout 5 members monthly, card 4242 | orchestrator in Chrome | entitlement active; seats 5; ledger `payment` matched to household and purchaser; fee/net filled (now or after reconcile) |
| E2 | Checkout 7 members yearly | Chrome | price `rootaroo_hh7_year` 12775; seats 7 |
| E3 | 3DS card 4000 0025 0000 3155 | Chrome | active after authentication |
| E4 | Declined 4000 0000 0000 9995 | Chrome | no subscription; still 402 |
| E5 | Renewal, failure, grace, blocked, recovery | test clock | past_due with grace_until = invoice finalized + 7 days; allowed during grace; blocked after; restored after payment method update and invoice pay |
| E6 | Seat increase 5 to 7 and interval month to year | API (`/billing/plan`) | proration invoice paid; seats change only after payment; plan_change_version increments |
| E7 | Failed upgrade leaves pending_update, then it expires | test clock + failing card | seats unchanged; admin notified on expiry |
| E8 | Cancel at period end (API equivalent of the portal) | API | access until period end; blocked after clock advance |
| E9 | Partial and full refund | API | ledger refund rows with status; summary net correct |
| E10 | Dispute 4000 0000 0000 0259 | Chrome or API | ledger dispute row; review item; staff alert recorded |
| E11 | Missed webhook | stop listener, pay, restart | checkout sweep or reconcile repairs state; run row recorded |
| E12 | Planted drift | corrupt status, seats or cancel flag in DB | reconcile auto_fixed items |
| E13 | Test cohort bypass and mode isolation | admin cohort API | test cohort allowed with no subscription; a test subscription cannot unlock a live-cohort household |
| E14 | Duplicate subscriptions | two Checkout sessions, or the API | healthy one kept; other cancelled; overlap refund only; review item |
| E15 | Staff API | none | transactions filtered by household/user; CSV; summary arithmetic matches ledger; review queue resolve; event replay |

### Wave 10 gate
- Every scenario passes with its evidence JSON committed. `docs/superpowers/evidence/w10-e2e.md` summarises pass/fail per scenario.
- The full unit and integration suites are still green.
- Any defect found gets a failing test, then a fix, then the affected scenario re-run.

---

## Wave 11: Apple IAP and Google Play Billing (spec §16)

Server side is complete and tested with fixtures. The app side is wired behind routing. Real purchases need the owner's devices and store accounts (checklists below).

### Task 11.1: Provider-neutral purchase interface
`modules/billing/iap/types.ts` defines `VerifiedPurchase { provider, livemode, productId, seats, interval, originalTransactionId or purchaseToken, status, expiresAt, householdId }`. The household ID comes from `appAccountToken` (Apple) or `obfuscatedAccountId` (Google). Upserts go through a new `upsertStoreSubscription(vp)`, which reuses the entitlement, grace, duplicate (review-only for store providers) and ledger paths. Product IDs are `rootaroo.hh{5..10}.{month|year}`.

### Task 11.2: Apple
- App Store Server Notifications V2 receiver `POST /api/v1/billing/webhooks/apple`: verify the JWS signature chain (x5c) against Apple Root CA G3 (vendored PEM), check the bundle ID and environment (Sandbox maps to livemode=false, Production to true), persist to `billing_events`, and process through the worker.
- `POST /api/v1/billing/iap/apple/verify {signedTransaction}` (admin only): verify the JWS, check `appAccountToken` equals the household ID, upsert.
- App Store Server API client (JWT ES256 with `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`) for `getAllSubscriptionStatuses`, used by reconcile.
- Fixture tests: valid and invalid chain, wrong bundle, sandbox vs production, and the notification types SUBSCRIBED, DID_RENEW, DID_FAIL_TO_RENEW with grace, EXPIRED, REFUND and DID_CHANGE_RENEWAL_PREF.

### Task 11.3: Google
- RTDN Pub/Sub push receiver `POST /api/v1/billing/webhooks/google`: verify the Google-signed OIDC bearer token (audience is the configured URL, email is the configured push service account), decode the message, then fetch the truth from the Play Developer API `purchases.subscriptionsv2.get` (service-account JWT). License-test purchases (`testPurchase`) map to livemode=false.
- `POST /api/v1/billing/iap/google/verify {purchaseToken, productId}` (admin only): verify, check `obfuscatedExternalAccountId` equals the household ID, acknowledge the purchase, upsert.
- Fixture tests for each notification type and the acknowledgement path.

### Task 11.4: Reconciliation, staff API and cohort for store providers
Reconcile store subscriptions through their APIs. The staff API lists them. `cohort --force` handles store subscriptions by raising a review item (we can't cancel them).

### Task 11.5: Mobile IAP integration
Add the IAP library (verify the current recommendation against Expo SDK 54 docs, for example `expo-iap`), then:
- `purchaseFlow` dispatches on `purchaseMethod` (`apple_iap` or `google_play`); on success, send the receipt or token to the verify endpoint.
- Restore purchases.
- Send the storefront or billing country in `X-Store-Country`.
- Manage subscription opens the store's page.
- Jest tests with the module mocked.

Requires a new EAS dev-client build.

### Task 11.6: Device checklists
`docs/billing/device-test-checklist.md`, covering:
- Apple: sandbox tester, StoreKit configuration file, purchase, renew, cancel and refund, and ASSN delivery to a tunnel.
- Google: license tester, internal testing track, purchase, renew and cancel, and RTDN delivery.
- Cross-provider: duplicates.

Marked owner-run.

### Wave 11 gate
Unit and integration suites green; fixture coverage of every notification type; mobile tests green; checklists committed. New env vars documented in `.env.example` (names only).

---

## Wave 12: Documentation, final verification, push

### Task 12.1: Documentation
- `docs/billing/README.md`: architecture, money flows, env vars per environment, local dev setup (Docker MySQL and Redis, `stripe listen --latest`), how to run each test layer.
- `docs/billing/runbooks.md`, one runbook per spec §15 item: key rotation, webhook secret rotation, review queue, refunds and disputes, cohort changes, price changes and migrations, routing changes.
- `docs/superpowers/evidence/README.md`: evidence index.
- A short root README pointing to these.

### Task 12.2: Final verification
On a fresh, clean local database built from migrations only:
- full unit, integration and coverage runs;
- tsc, lint, mobile tests, Android bundle export;
- the secret scan over the full branch diff;
- `git grep rootaru`.

Record everything in `docs/superpowers/evidence/w12-final.md`.

### Task 12.3: Acceptance (owner DB)
Only after the owner confirms: take a schema dump of the owner's `rootaroo_dev`, run migrations, run the smoke subset (status, plans, checkout session creation, webhook trigger), and record the results.

### Task 12.4: Push
`git push -u origin feat/billing`, then report the branch and its evidence. No PR unless the owner asks.
