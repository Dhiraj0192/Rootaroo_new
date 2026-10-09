# Service adapters

External vendors sit behind one interface per category (`server/src/services/`). Callers use the getters (`getEmail()`, `getSms()`, `getPush()`, `getStorage()`, `getWeather()`, `getErrorReporter()`, `getKeyVault()`), and the provider is chosen by environment variable. The choice is validated at startup, and the server exits with a clear message if it is invalid. Billing and calendar/auth vendor code are domain logic and are not adapters.

| Category | Env var | Providers | Default |
| --- | --- | --- | --- |
| Email | `EMAIL_PROVIDER` | `resend`, `log` | `resend` if `RESEND_API_KEY` is set, else `log` |
| SMS | `SMS_PROVIDER` | `twilio`, `log`, `disabled` | `twilio` if `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` are set; else `log`, or `disabled` in production |
| Push | `PUSH_PROVIDER` | `expo`, `log` | `expo` |
| Storage | `STORAGE_PROVIDER` | `s3` | `s3` |
| Weather | `WEATHER_PROVIDER` | `open-meteo` | `open-meteo` |
| Monitoring | `MONITORING_PROVIDER` | `sentry`, `console` | `sentry` if `SENTRY_DSN` is set, else `console` |
| Key vault | `KEY_VAULT_PROVIDER` | `aws-kms`, `local` | `local` (in production it must be set explicitly, with a strong secret) |

Leave a variable empty to use its default.

## Rules

- A vendor provider needs its credentials (for example `EMAIL_PROVIDER=resend` needs `RESEND_API_KEY`); otherwise startup fails.
- Production refuses the `log` provider for email, SMS and push.
- Production without Twilio credentials runs with SMS `disabled` and a startup warning: phone sign-in codes cannot be sent.
- `log` providers write the recipient (and subject for email) but never the message body, since bodies carry sign-in codes.
- Key vault holds the keys that protect private-space backups (MAC of the backup proof, encryption of the stored blob), bound to the user id. `aws-kms` needs `KEY_VAULT_REGION`, `KEY_VAULT_MAC_KEY_ID` (an HMAC_SHA_256 key) and `KEY_VAULT_ENC_KEY_ID` (a symmetric key), and gives hardware protection. `local` derives both keys from `KEY_VAULT_LOCAL_SECRET` (32+ characters, or a built-in development secret when unset outside production) and logs a warning; production accepts it with `KEY_VAULT_PROVIDER=local` and a secret of 64+ characters that differs from `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `CALENDAR_TOKEN_KEK`. Each backup records its provider, so moving to `aws-kms` later loses nothing while `KEY_VAULT_LOCAL_SECRET` stays set. A vault error fails the request closed and never counts as a wrong password. See `docs/e2e/device-transfer.md`.
- Weather readings are cached in Redis for 10 minutes; a Redis outage only skips the cache.
- Unhandled route errors are passed to the monitoring provider; responses are unchanged.

## Adding a provider

Implement the interface in `server/src/services/types.ts`, add the file under `services/providers/`, add the name to `config.ts` and wire it in `services/index.ts`. Tests can swap any provider with `__setServicesForTests`.
