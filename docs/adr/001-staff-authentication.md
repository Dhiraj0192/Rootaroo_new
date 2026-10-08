# ADR-001-staff-authentication: Cloudflare Access, then a passkey, then server-side sessions

**Status:** Proposed
**Date:** 2026-10-09
**Feature:** 001-admin-panel

## Context

The admin panel can:
- suspend accounts;
- approve household deletion;
- switch campaigns on for every user;
- see revenue and billing records.

**Threats:**
- a stolen staff session (the main one);
- phishing a staff member;
- credential stuffing;
- reaching the staff API without passing Cloudflare (for example through a public Railway address);
- forged cross-site requests;
- a staff member who leaves but keeps access;
- a staging passkey or session working in production.

The owner chose Cloudflare Access as an outer gate (free for up to 50 users) on top of each person's own login. Staff must not exist in the app's `users` table.

## Options Considered

### Option A: Cloudflare Access, then a passkey only, then database-backed sessions on one origin

Described in full under Decision.

**Pros:**
- Phishing-resistant end to end.
- One origin, so there are no cross-host cookie or CORS problems.
- The staff API has no public address.

**Cons:**
- Two systems to set up: Cloudflare, plus our own WebAuthn.
- Every staff member needs a passkey-capable device or security key.

### Option B: Cloudflare Access, then a passkey with an authenticator code (TOTP) as a second way to sign in

**Pros:**
- A fallback when someone loses their passkey.

**Cons:**
- A code that signs someone in by itself can be phished or relayed. That undoes the reason for passkeys.
- It adds a secret-storage path (key vault), lockout logic and its own tests.
- Recovery by owner re-invite covers the same need more safely.

### Option C: Cloudflare Access only (SSO identity passed through, no own login)

**Pros:**
- Least code to write.

**Cons:**
- Our security rests entirely on one third-party policy and the email in the JWT.
- No step-up check before risky actions.
- If a Cloudflare policy is set up wrong, everything behind it is open at once.

## Decision

**We chose Option A.** The PRD asks for per-person accountability, and the owner chose Cloudflare Access. Passkey-only sign-in keeps the whole path phishing-resistant, and one origin removes the cross-host gaps.

**1. One origin, no public API.**
- The Caddy container that serves `admin.<domain>` also reverse-proxies `/api/*` to the staff service over Railway's private network.
- The staff service has no public Railway domain or proxy. A startup check refuses to run if `PROCESS_ROLE=staff` and a public port is configured.
- The browser sends Cloudflare's `CF_Authorization` cookie to the same host, and Cloudflare adds `Cf-Access-Jwt-Assertion` to every proxied request.

**2. Cloudflare Access JWT check, fail closed, on every staff route.**
- **Keys:** RS256 only, against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached with the key ID.
- **Claims:**
  - exact `iss`;
  - `aud` equal to this environment's `CF_ACCESS_AUD`;
  - `exp` and `nbf` with at most 60 seconds of clock skew;
  - a user identity is required, and service tokens are refused.
- **Binding:** the session is bound to the JWT `sub` and the normalised email. A mismatch ends the session.
- **Local development:** `STAFF_CF_ACCESS=off` skips the check only when `NODE_ENV !== 'production'` and the request comes from loopback. Startup fails if it is set in production.

**3. Passkey sign-in.**
- WebAuthn via `@simplewebauthn/server`.
- `userVerification: 'required'`, and the sign-count is checked.
- The relying-party ID is the full admin host, for example `admin.rootaroo.com`, so staging passkeys never work in production.
- Challenges are random, stored server-side, single-use, expire in 2 minutes, and are bound to the Cloudflare `sub`.
- A person may register up to 3 passkeys, for example laptop plus security key.

**4. Invites.**
- Invite links carry a 256-bit token, stored hashed, valid for 24 hours, single-use.
- An invite is accepted only when the verified Cloudflare email equals the invited email. Accepting it means registering a passkey.
- Cancelling an invite deletes its hash.
- An owner invite needs a step-up check and notifies every owner by email.
- The first owner is created by a CLI command run on the staff service.

**5. Recovery.**
- When someone loses their passkeys, an owner uses "Reset sign-in" (step-up, reason required, audited). It:
  - deletes that person's passkeys and sessions;
  - emails them;
  - sends a fresh invite link.
- The last owner recovers through the CLI.
- There is no code or password fallback.

**6. Sessions.**
- A random 256-bit ID, stored hashed in `staff_sessions` (database only, no Redis cache, so revoking takes effect immediately). Each row holds `created_at`, `last_seen_at`, `step_up_until`, `cf_sub`, IP and user agent.
- The cookie is `__Host-staff_session`: httpOnly, Secure, SameSite=Strict, Path=/.
- 15 minutes idle and 8 hours absolute, both enforced on the row.
- The session ID rotates on sign-in.
- Role change, deactivation and sign-in reset delete all of that person's sessions before the response returns.

**7. Cross-site request protection.**
- Writes need an `Origin` header that exactly equals the admin origin. A missing `Origin` is refused.
- Writes also need the `X-Staff-Request: 1` header.
- No CORS is needed, since everything is same-origin, so none is enabled.

**8. Step-up.**
- A passkey check sets `step_up_until` on the session row for 5 minutes.
- **Needs step-up:**
  - suspend or unsuspend;
  - staff invite, role change, deactivation and sign-in reset;
  - campaign switches;
  - billing resolve and replay;
  - revealing a full email or phone number;
  - billing CSV export;
  - registering a new passkey.
- **Single-use step-up**, consumed by the action, for approving a household deletion and for any change to the owner role.

**9. Last owner.**
- Demoting, deactivating or resetting the last active owner is refused inside a database transaction that locks the owners' rows. This applies in the UI and the CLI.

**10. Rate limits.** Stored in Redis, and they fail closed: if Redis is down, sign-in and step-up are refused.

| Action | Limit |
|---|---|
| Sign-in and step-up attempts | 10 per 15 minutes per staff account plus IP |
| Lookups | 300 a day per staff member |
| Reveals | 50 a day per staff member |
| CSV exports | 20 a day per staff member |
| Replays | 50 a day per staff member |

Hitting a limit is audited.

## Consequences

**Easier:**
- **Offboarding:** deactivating a person deletes their sessions, and their next request fails. Removing them from Cloudflare Access blocks them even earlier.
- **Adding SSO later:** Cloudflare Access can switch to Google Workspace or Okta without code changes.

**Harder:**
- Staging and production each need their own Cloudflare Access application (`CF_ACCESS_AUD`), relying-party ID and cookie, which keeps test and production apart.
- Local runs use a seeded test owner and the loopback-only bypass.
- Losing every passkey means waiting for an owner. That is intended.

**If superseded:**
- Replacing passkeys touches only `staff_credentials` and the sign-in routes.
- Sessions, step-up and permissions stay the same.
