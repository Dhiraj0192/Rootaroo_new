# PRD: Admin panel

**Date:** 2026-10-09
**Feature:** 001-admin-panel

## Problem

The Rootaroo team has no admin panel:
- Staff actions run through two shared API keys (`ADMIN_API_KEY`, `ADMIN_BILLING_API_KEY`) and curl.
- Nobody can see revenue or Stripe details without opening the Stripe dashboard.
- Household leave and delete requests, support lookups and the campaign switches have no screen.
- The audit log can't say which person did something.

Campaigns are built but stay off until someone can switch them safely. Account suspension and request approvals need a person, with a recorded reason.

## Users & Context

**Labels:** the work ships in three stacked PRs:
- **W6:** foundation, sign-in, staff and audit.
- **W7:** billing, requests, support, campaigns.
- **W8:** metrics.

`T`-numbers are items in [`docs/TRACKER.md`](../../TRACKER.md):
- **T2, T3:** future campaigns and emails.
- **T10:** retire the shared admin keys.

**Users:** a small internal team, under 50 people, signing in from desktop browsers. Each person has one role:

| Role | Who | Main jobs |
|---|---|---|
| Owner | Founders | Everything: staff, campaigns, billing fixes, audit |
| Support | Support staff | Find a person or household, see account metadata, suspend abusers, decide requests |
| Billing | Finance | Revenue, transactions, exports, reconciliation, webhook replay |
| Viewer | Anyone who needs numbers | Read metrics and revenue |

**Existing systems this touches:**
- **Billing staff services** in `server/src/modules/billing/admin/`: transactions, CSV export, summary, subscriptions, household billing, reconciliation runs and items, resolve, event replay, cohort, routing.
- **The ledger:** amount, fee, net, dispute fee, funds state, provider charge, invoice and receipt IDs.
- **Household requests** routes in `server/src/modules/admin/`: list, approve, reject.
- **Campaign settings**: master switch, one switch per rule, the signed-out nudge switch, and the copy in `server/src/modules/campaign/copy.ts`.
- **The device registry and sign-in data** (W9/W10).
- **`admin_audit_log`.**
- **Cloudflare Access**, in front of the admin host.
- **E2E:** chats, journals and vault files are end-to-end encrypted. The panel only ever sees metadata.

**Design:** the mockups are on the canvas at https://claude.ai/artifact/Ve9HUZBtre1ziAMiGoHAY9 (private; share it from the page to give others access):
- **Fonts:** Plus Jakarta Sans for text and JetBrains Mono for labels and IDs, as on rootaroo.com.
- **Colours:** navy background `#0B1426`, glass cards (white at 4.5% over the navy, with a 10% white edge), honey accent `#E0B563` with dark text on top, sage `#8FBF8C` for good, coral `#E2795A` for danger, blue `#93C5FD` only for billing test mode.
- **Dark only.**

**The UI is simple first, detailed on demand:**
- Every section opens on a short summary: key numbers and the items that need action.
- Detail comes from filters, a detail side panel that opens from any row, and a "Find anything" search (Ctrl K) for a person, household or Stripe ID.
- Nothing needs more than two clicks to reach.

## Goals

1. **Staff accounts and safety (W6):**
   - per-person, invite-only staff accounts behind Cloudflare Access;
   - passkey-only sign-in (recovery is an owner re-invite; the last owner recovers through the CLI);
   - short sessions, and a fresh passkey or code check before risky actions;
   - four roles mapped to fine-grained permission names that the server checks on every request ([ADR](../../adr/001-admin-authorization-and-audit.md)).
2. **Staff and audit section (W6):**
   - invite, change role, deactivate, cancel an invite;
   - a read-only table of what each role can do;
   - an audit log viewer that filters by person, action and date, and flags a broken hash chain.
3. **Billing and revenue section (W7):**
   - **Revenue tab:**
     - monthly recurring revenue (MRR), yearly (ARR), net revenue after fees and refunds, paying households and average revenue per household, churn, failed payments;
     - a 12-month MRR chart;
     - the month by source (Stripe, App Store, Google Play): gross, fees, refunds, net;
     - a breakdown by plan and billing period.
   - **Transactions tab:**
     - filters and search, plus a CSV export;
     - a detail panel for each row: amount, fee, net, funds state, card brand and last four digits, plan, every provider ID with a copy button (customer, subscription, invoice, charge, refund, dispute; App Store and Google Play IDs), the webhook events received, and an "Open in Stripe" link to the right test or live dashboard.
   - **Subscriptions, Reconciliation (run history, review queue, Resolve), Webhook events (Replay) and Store routing tabs** over the existing services.
   - A Live/Test switch that changes every number and shows a blue test-mode bar.
4. **Household requests (W7):** a waiting/decided queue of leave and delete-household requests with approve or reject.
5. **Support (W7):**
   - find a person or household by email, phone, user ID or household ID;
   - see metadata only: members and roles, plan and mode, which phone holds the key, recent sign-ins, open requests;
   - suspend or unsuspend with a required reason;
   - emails and phone numbers masked until revealed with the `support.reveal` permission.
6. **Campaigns (W7):**
   - the master switch, one switch per rule and the signed-out nudge switch, all off by default and owner-only;
   - each rule shows when it fires, its copy lines, its state ("Sending", "On, waiting for master", "Off") and who last changed it;
   - a new campaign or email (T2, T3) must add its switch here.
7. **Overview metrics (W8):**
   - sign-ups, active households (day, week, month), retention by sign-up month, paid conversion, MRR, push failure rate, campaign sends and open rate;
   - read from summary tables that a nightly job fills, so the panel never runs heavy queries live.
8. **Retire the shared keys:** delete the `ADMIN_API_KEY` and `ADMIN_BILLING_API_KEY` routes once W7 covers their screens (T10).
9. **Built to grow:** each section is a self-contained module on the server and in the app. A new section is a new module plus its permission names ([ADR](../../adr/001-admin-architecture.md)).

**Metric definitions (W8):**

| Metric | Definition |
|---|---|
| Sign-ups | New `users` rows, by UTC day |
| Active household | At least one member opened the app that day, week or month |
| Retention by sign-up month | Of households created in month M, the share still active in month M+n |
| Paid conversion | Households with an active or past-due paid subscription ÷ all households that are not deleted |
| Push failure rate | Expo tickets or receipts with an error ÷ pushes sent, over the range |
| Campaign open rate | Campaign pushes opened ÷ campaign pushes sent (from `campaign_sends`) |

**Role permissions** (the source of truth is `server/src/staff/permissions.ts`; the Staff screen shows this table):

| Permission | Owner | Support | Billing | Viewer |
|---|---|---|---|---|
| `metrics.read` | ✓ | ✓ | ✓ | ✓ |
| `support.lookup` (masked) | ✓ | ✓ | | |
| `support.reveal` | ✓ | ✓ | | |
| `account.suspend` | ✓ | ✓ | | |
| `requests.decide` | ✓ | ✓ | | |
| `billing.read` | ✓ | | ✓ | ✓ |
| `billing.export` | ✓ | | ✓ | |
| `billing.write` (resolve, replay) | ✓ | | ✓ | |
| `campaign.write` | ✓ | | | |
| `staff.manage` | ✓ | | | |
| `audit.read` | ✓ | | | |

**Smaller decisions, recorded here rather than as ADRs:**
- **Metrics come from summary tables** filled by one nightly job. The overview shows when the job last ran. This is the only sensible option at our size, so it isn't contested.
- **Revenue numbers come from our own ledger and subscription mirror**, not live Stripe calls. Reconciliation keeps them correct. MRR counts active and past-due subscriptions, with yearly plans divided by 12.
- **Test and production stay apart:**
  - separate deploys, staff tables and Cloudflare Access apps;
  - `CF_ACCESS_AUD`, the WebAuthn relying-party ID and the cookie are set per environment;
  - every billing request needs `mode=test|live`, and test data never mixes into live totals;
  - event replay runs only when the event's `livemode` matches the requested mode, using that mode's Stripe key;
  - the Live/Test switch affects billing views only. Suspension, requests and campaigns act on the environment's own production or staging data.
- **One origin:** Caddy serves the app and proxies `/api/*` to the staff service over the private network. The staff service has no public address. `STAFF_PORT` and the admin origin are set per environment.
- **Production runs two Railway services from one image** (`PROCESS_ROLE=app|staff`).

## Non-Goals

- Seeing any user content: chats, journals, vault files, feed posts or photos.
- Impersonating a user or signing in as them.
- Issuing refunds or editing prices in the panel. Refunds stay in Stripe or the store; the panel links there.
- Editing campaign copy in the panel. Copy stays in code and is reviewed in pull requests.
- Custom roles or per-person permission changes at runtime.
- Light mode, phone-first layouts, or other languages. Screens still work at phone width.

## Success Criteria

- Every staff action in production is tied to a named person in the audit log, and a test proves the app's database user can't update or delete audit rows.
- Requests to the staff API without a valid Cloudflare Access JWT, a valid session, the right origin, or the needed permission are refused. Table-driven tests cover every route against every role.
- Each member of staff reaches any section within two clicks of signing in. Support finds a household from an email or ID in one search.
- The finance user can answer "what did we make last month, net of fees and refunds, by source?" and "what are the Stripe IDs for this payment?" without opening Stripe.
- Campaigns can be switched on rule by rule by an owner, with the switch and its author visible, and nothing sends while the master switch is off.
- The shared `ADMIN_API_KEY` and `ADMIN_BILLING_API_KEY` are gone from code and configuration after W7.
- The admin site scores A+ on securityheaders.com: strict CSP with no inline scripts, HSTS, and `frame-ancestors 'none'`.
- Overview pages load in under one second on a normal connection. They query only the summary tables.

## Architecture Decisions

- [Own admin app plus a separate staff API in the existing server](../../adr/001-admin-architecture.md): a React static app plus a staff API on its own host and port that reuses the server's services. Each section is a module.
- [Staff authentication](../../adr/001-staff-authentication.md):
  - Cloudflare Access, with its JWT checked at the API;
  - then a passkey (no code or password fallback; recovery is an owner re-invite);
  - server-side sessions in a `__Host-` cookie, signed out after 15 minutes idle and 8 hours at most;
  - origin and header checks against forged requests, and a fresh check before risky actions.
- [Authorization and audit](../../adr/001-admin-authorization-and-audit.md): permission names behind four fixed roles mapped in code, checked on every route. The audit log can only be added to and is hash-chained.
- [Frontend stack](../../adr/001-admin-frontend-stack.md): React, Vite, TanStack Router/Query/Table, Tailwind, Radix and Lucide, served as static files by Caddy with strict security headers.

## Out of Scope

- **Owner items:** setting up Cloudflare Access and DNS, the Railway services, and the database grants. The plan lists them as owner steps.
- **Self-hosting the fonts.**
- **Payouts and bank balances.** Stripe and the stores report these, and the panel links out.
- **Alerting and paging.** Reconciliation alert emails already exist.
- **Two-person approval for risky actions.** We can add it later as a permission rule if the team grows.
- **Moving roles and permissions into the database.** Revisit if the team outgrows four roles.
