# Rootaroo

Household app: Expo mobile client (`mobile/`) and Express/TypeScript API (`server/`).

## Billing

Subscriptions use Stripe (hosted Checkout, Billing Portal) with Apple/Google in-app purchases where store rules require them.

- Overview, architecture, env vars and how to run tests: [`docs/billing/README.md`](docs/billing/README.md)
- Operational runbooks: [`docs/billing/runbooks.md`](docs/billing/runbooks.md)
- Local testing guide: [`docs/billing/local-testing.md`](docs/billing/local-testing.md)
- Project tracker (to do, waiting on decisions, done, dropped): [`docs/TRACKER.md`](docs/TRACKER.md)
- Evidence index: [`docs/superpowers/evidence/README.md`](docs/superpowers/evidence/README.md)

## Private space (journal and vault encryption)

- Account key, moving to a new phone, backup and recovery (the design): [`docs/e2e/device-transfer.md`](docs/e2e/device-transfer.md)
- Journal encryption: [`docs/e2e/journal.md`](docs/e2e/journal.md)
- Shared household vault: [`docs/e2e/vault.md`](docs/e2e/vault.md)

## Notifications, location and services

- Push campaigns and their admin switches: [`docs/push/campaigns.md`](docs/push/campaigns.md); device checklist: [`docs/push/device-test-checklist.md`](docs/push/device-test-checklist.md)
- Location sharing: [`docs/location-sharing.md`](docs/location-sharing.md); device checklist: [`docs/location-sharing-device-checklist.md`](docs/location-sharing-device-checklist.md)
- External services (email, SMS, push, storage, weather, monitoring, key vault) and their settings: [`docs/services.md`](docs/services.md)
- Sign-in, sessions and devices: [`docs/auth-documentation.html`](docs/auth-documentation.html)
