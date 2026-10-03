# Wave 5 evidence: checkout, return, sync, portal, plan change, routing

Branch `feat/billing`. Tasks 5.1 to 5.7 each have their own commit (see `git log`).

## Gate (run from `server/` with `.env.impl`)

| Check | Result |
|---|---|
| `npx jest` | 46 suites, 658 tests, all pass |
| `npm run test:int` | 15 suites, 97 tests, all pass (rootaroo_test) |
| `npm run type-check` | clean |
| `npm run lint` | 0 errors, 148 warnings (all `no-explicit-any` style warnings, no new rule classes) |

Note: one earlier `test:int` run showed 7 failures in 4 suites. It overlapped with a second `test:int` process
sharing the same `rootaroo_test` database and Redis; the same suites pass alone and in a clean full run. Not a code defect.

## Live sandbox spot-check (dev Stripe sandbox, test mode, no payment completed)

A temporary script (not committed) created a household and admin in `rootaroo_impl`, then called
`POST /api/v1/billing/checkout` (`{interval: month, seats: 5}`, `X-Platform: android`) twice through the real app against the real Stripe sandbox.

1. With `BILLING_REQUIRE_TOS_CONSENT` unset (default `true`): Stripe rejected session creation:
   "You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard."
   The API returned `502 CHECKOUT_FAILED`, as designed.
2. With `BILLING_REQUIRE_TOS_CONSENT=false`:
   - first call: `200`, session id prefix `cs_test_a1WhTW`, URL on `https://checkout.stripe.com/c/pay/cs_tes...`
   - second call: `200`, same session id (single-flight and reuse confirmed)
   - `GET /api/v1/billing/status`: `200`, `pendingCheckout = { state: "open", sessionId: cs_test_a1WhTW... }`, `purchaseMethod = stripe_checkout`, `plans` present
   - The session was left open and expires on its own (31 minutes). No payment was made.

Not done here (orchestrator, Wave 10): opening the Checkout URL in Chrome to confirm $8.99/month, the auto-renewal text on the submit button and the Terms checkbox.
Unit tests assert the exact parameters sent (`custom_text.submit.message`, `consent_collection`, `origin_context: mobile_app`, `integration_identifier`, `expires_at >= 30 min`).

## OPEN ITEM for the owner: Terms of Service URL in the Stripe sandbox

The sandbox has no Terms of Service URL, so `consent_collection.terms_of_service: 'required'` fails.
Set it at https://dashboard.stripe.com/settings/public (Terms of service URL), in the sandbox and later in the live account.
Until then run dev with `BILLING_REQUIRE_TOS_CONSENT=false`.

The flag is new in this wave:
- `BILLING_REQUIRE_TOS_CONSENT` (default `true`); documented in `server/.env.example`.
- Startup refuses `false` in production and logs a warning when it is `false` elsewhere.
- Test: `config.test.ts` (flag semantics) and `checkout.int.test.ts` ("omits consent_collection only when ... is off").
- Do not leave it `false` once the URL is configured; the Terms checkbox is a launch requirement.

## Deviations from the plan

1. `billing_cycle_anchor` on `subscriptions.update` is an object in API `2026-09-30.endive`: `{ type: 'now' }`, not the string `'now'`
   (the SDK types reject the string). `plan.ts` and the test use the object form. Docs confirm `billing_cycle_anchor` is supported with `pending_if_incomplete`.
2. `BILLING_REQUIRE_TOS_CONSENT` flag added to `config.ts` (see above); `requireTosConsent` is part of `BillingConfig` and `testBillingConfig`.
3. `duplicates.ts`: one type annotation added to the `retrieve(...).catch(...)` map callback so the type predicate compiles (no behavior change).
4. Test helper `post(user, body)` takes `body: object` instead of `unknown` (supertest `.send` typing).
5. One extra integration test was added for the ToS flag. `portal.ts` gained `openPortal` in Task 5.7 (as planned), while `createPortalUrl` came in 5.5.

## Verified against docs.stripe.com

- `checkout/sessions/create`: `origin_context` is `mobile_app | web`; `integration_identifier` (max 200); `expires_at` 30 minutes to 24 hours; `custom_text.submit`; `consent_collection`.
- `billing/subscriptions/pending-updates-reference`: `billing_cycle_anchor`, `items`, `proration_behavior` are supported with `pending_if_incomplete`.
- Customer search `metadata['key']:'value'` syntax: executed live by the spot-check (search returned no match, then a customer was created) without error.
