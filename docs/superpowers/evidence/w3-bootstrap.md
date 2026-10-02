# Task 3.2 evidence: Stripe bootstrap against the dev sandbox (test mode)

Command (twice): `cd server && npm run billing:bootstrap -- --mode test --skip-webhooks`
(BILLING_ENV_TAG=dev, BILLING_PUBLIC_BASE_URL is http://localhost:3000, so webhook registration is skipped; local dev uses `stripe listen`.)

## Run 1 (created)
```
products: 5=prod_VMwxUP3q.. 6=prod_VMwxX6P1.. 7=prod_VMwxTt3O.. 8=prod_VMwxC29a.. 9=prod_VMwxn2BL.. 10=prod_VMwxnNmF..
prices: rootaroo_hh{5..10}_month:created rootaroo_hh{5..10}_year:created   (12 created)
portal configuration bpc_1UMD440dWk0w8nqY...: created
```

## Run 2 (idempotent)
```
products: (same 6 ids reused, none created)
prices: all 12 keys: exists
portal configuration bpc_1UMD440dWk0w8nqY...: updated
```
Objects created in the sandbox in total: 6 products, 12 prices, 1 portal configuration. Nothing created by run 2.

## `stripe prices list --lookup-keys rootaroo_hh7_year` (excerpt)
unit_amount 12775, currency usd, tax_behavior exclusive, recurring year/1, lookup_key rootaroo_hh7_year,
metadata { interval: year, price_set: 2026-10, seats: 7 }, nickname "rootaroo_hh7_year 2026-10", livemode false.

## Notes
- Webhook endpoint registration skipped (non-https base). `--skip-webhooks` is also supported explicitly; `ensureWebhookEndpoint` itself skips non-https bases.
- Sandbox Terms of Service URL (Settings > Public details) is an open item for the orchestrator (needed by Task 5.5).
- Docs checked: customer_portal/configurations/create, webhook_endpoints/create (api_version), prices/create (transfer_lookup_key).
