> **Superseded:** E1 to E4 were completed and pass (see `E1.json` to `E4.json` and `../w10-e2e.md`). This file is kept for history.

# Pending: hosted Checkout scenarios (E1, E2, E3, E4)

The claude-in-chrome extension was not connected during Wave 10, so the four scenarios that need the
Stripe-hosted Checkout page were not run. Everything else (E5 to E15) passed; see `../w10-e2e.md`.

## Setup (from `server/`)

1. `set -a && . ./.env.impl && set +a` (DB `rootaroo_impl`, Docker MySQL 3307, Redis 6379; the file also holds
   `STRIPE_TEST_WEBHOOK_SECRETS`, `ADMIN_BILLING_API_KEY` and `BILLING_REQUIRE_TOS_CONSENT=false`; it is gitignored).
2. Start the server: `npx tsx src/index.ts > /tmp/server.log 2>&1 &` and wait for `Port: 3000`.
3. Start the listener (the key is read from `server/.env`, never echoed):
   `export STRIPE_API_KEY=$(node -e "require('dotenv').config();process.stdout.write(process.env.STRIPE_TEST_SECRET_KEY)")`
   then `stripe listen --latest --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.pending_update_applied,customer.subscription.pending_update_expired,invoice.paid,invoice.payment_failed,invoice.payment_action_required,checkout.session.completed,checkout.session.expired,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.updated,charge.dispute.funds_withdrawn,charge.dispute.funds_reinstated,charge.dispute.closed,customer.updated --forward-to localhost:3000/api/v1/billing/webhooks/stripe/test &`
   The CLI's signing secret is stable per account, so the `whsec` already in `.env.impl` still matches. If the listener prints a different one, replace `STRIPE_TEST_WEBHOOK_SECRETS` in `.env.impl` and restart the server.

## Run each scenario

`npx tsx scripts/e2e/hosted.ts E1` (then E2, E3, E4). Each script seeds a household through the real API, calls
`POST /billing/checkout`, prints a line `CHECKOUT_URL <url>` and waits up to 20 minutes (`E2E_HOSTED_WAIT_MS`).
Open the URL, pay with the card the script prints, then the script asserts and writes `E<n>.json` here.

| Scenario | Card | Page action | Script waits for |
|---|---|---|---|
| E1 monthly, 5 members | 4242 4242 4242 4242 | submit | entitlement active via sync, ledger payment matched, fee/net |
| E2 yearly, 7 members | 4242 4242 4242 4242 | submit | price 12775, seats 7 |
| E3 3DS | 4000 0025 0000 3155 | submit, then "Complete" on the 3DS test modal | entitlement active |
| E4 declined | 4000 0000 0000 9995 | submit; the page shows the decline and stays open | create the file `server/scripts/e2e/.continue-E4` afterwards; asserts no subscription, still 402, session reused |

Use any future expiry, any CVC, ZIP 10001, any name. The Terms of Service checkbox is not shown because the server runs
with `BILLING_REQUIRE_TOS_CONSENT=false` (the sandbox has no Terms URL yet).

## Stop everything afterwards
Stop the server and `stripe listen` (`taskkill /IM stripe.exe /F` on Windows).
