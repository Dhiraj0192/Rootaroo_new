# Rootaroo tracker

One place for work that is planned, waiting on someone, finished or dropped. Update it in the same commit as the work.

- Move a row between sections instead of deleting it; dropped items keep their reason.
- IDs never change or get reused. Prefixes: `T` to do, `D` decision, `G` go-live step.
- Owner is a role (dev, owner, client), not a person.

## To do

| ID | Item | Area | Owner | Notes |
|---|---|---|---|---|
| T1 | Household data export in Settings (JSON download of the household's data) | server, mobile | dev | Follow-up PR, built test-first. Must work without a subscription so lapsed households can get their data. |
| T2 | Data retention for lapsed households: keep data 12 months after a subscription ends, email a warning before deletion, then delete | server, legal | dev, client | Resubscribing within the window restores everything. Needs wording in the Privacy Policy (T4). |
| T3 | "Come back" email to lapsed households every few months during the retention window, in a light, playful tone | server, content | dev, client | Same job as T2. Stops after deletion or when the household resubscribes. Exact cadence in D2. |
| T4 | Real Terms and Privacy pages | web, mobile | client | Being built at rootaroo.com/terms and rootaroo.com/privacy. The app links there already (`mobile/src/shared/billing/legalLinks.js`). Release blocker. |
| T5 | App Store and Google Play review accounts: one with an active subscription, one in the test cohort without one | release | owner | The second lets reviewers see the paywall, the sandbox purchase and account deletion. Submission notes should say that the purchase method follows the store country. |
| T6 | Real-device store purchases | mobile, release | owner | [`docs/billing/device-test-checklist.md`](billing/device-test-checklist.md) |
| T7 | Full unit and integration suites plus coverage in CI | ci | dev | Locally only targeted sets are run. |
| T8 | Stripe PaymentSheet as an in-app alternative to hosted Checkout | mobile | dev | Optional. Hosted Checkout stays the default for store-policy reasons. |
| T9 | MVP next pass, waves W1–W12: journal lock, push fixes and campaign, service adapters, location sharing, admin panel, device registry and transfer, journal E2E, shared vault | all | dev | [`docs/plans/mvp-next-pass.md`](plans/mvp-next-pass.md). One stacked PR per wave. |
| T10 | Remove the shared `ADMIN_API_KEY` and `ADMIN_BILLING_API_KEY` routes | server | dev | After the admin panel covers their screens (W7). |
| T11 | Remove the server-held passphrase backup of the account key | server, mobile | dev, owner | Kept for now as the fallback when no other device exists. Needs a replacement recovery path (e.g. a printed recovery key) decided first. |
| T12 | Sign every API request with the device identity key | server, mobile | dev | Makes a stolen session token useless on another device. After W9. |
| T13 | External cryptography review | security | owner | Before any public "end-to-end encrypted" claim. Covers W10–W12. |
| T14 | Re-encrypt household vault files when a member leaves | server, mobile | dev | Optional hardening after W12. |

## Go-live steps

In order, after the checklist in [`docs/billing/runbooks.md`](billing/runbooks.md) section 9.

| ID | Step | Owner |
|---|---|---|
| G1 | Stripe Dashboard access; public details (Terms URL), receipts, Smart Retries, portal | owner |
| G2 | Roll every key shared during development; restricted keys per environment | owner |
| G3 | Live keys and live webhook endpoint with its signing secret in production; run bootstrap for live mode | owner, dev |
| G4 | New EAS build (app scheme `rootaroo`, in-app purchase module) | dev |
| G5 | Set `BILLING_ENABLED=true` in production and restart | dev |
| G6 | Delete pre-launch test households, or move the ones testers keep to cohort `test` | dev |
| G7 | Remove the `BILLING_ENABLED` switch from the code | dev |

## Waiting on a decision

| ID | Question | Who decides | Notes |
|---|---|---|---|
| D2 | How often the "come back" email (T3) goes out | owner | "Every few months" agreed; proposal: every 3 months. |

## Decisions made

| ID | Decision | Date |
|---|---|---|
| D1 | Pre-launch households and accounts are test data: no grandfathering, no free period, no migration. | 2026-10-08 |
| D3 | Checkout charges in USD only (Adaptive Pricing off). | 2026-10-08 |
| D4 | A lapsed household gets a hard paywall but keeps Settings, profile, account deletion, help and the privacy policy. | 2026-10-08 |
| D5 | Data is kept 12 months after a lapse, with an email warning before deletion (T2). | 2026-10-08 |

## Done

| Item | Where |
|---|---|
| Stripe hosted Checkout, Apple and Google in-app purchases, paywall, test/live separation, staff API | PR #2 |
| Pre-launch switch `BILLING_ENABLED` (off by default) | PR #2 review |
| Paywall menu: settings, profile, account deletion, help, privacy policy | PR #2 review |
| Billing migrations safe to re-run after a partial failure | PR #2 review |
| Back button on the Subscription screen | PR #2 review |
| `jest` and `jest-expo` moved to dev dependencies | PR #2 review |
| Checkout locked to USD | PR #2 review |

## Dropped

| Item | Reason | Date |
|---|---|---|
| Moving old `rootaru_*` login keys to `rootaroo_*` on first launch | No released build used them; internal testers sign in once after updating. | 2026-10-08 |
| Keeping `rootaru://` invite links working | Only testers received them; they get new invites. | 2026-10-08 |
| Grandfathering or a free period for existing households | All existing households are test data (D1). | 2026-10-08 |
| Read-only access for lapsed households | Every screen would need a read-only state, and it weakens the paywall. Data export (T1) covers access to data. Revisit if many households lapse. | 2026-10-08 |
