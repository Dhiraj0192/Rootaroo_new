# ADR-001-admin-authorization-and-audit: Permission names behind fixed roles, and an add-only audit log

**Status:** Accepted
**Date:** 2026-10-09
**Feature:** 001-admin-panel

## Context

Staff have different jobs:
- an **owner** runs everything;
- **support** looks up households and suspends abusers;
- **billing** reconciles payments;
- a **viewer** reads numbers.

The owner wants control that is fine-grained but simple to run, and the panel must grow new sections without rewriting the checks. Every staff action, including support lookups that only read data, must be traceable to one person, and nobody may change the log afterwards.

The existing `admin_audit_log` table records billing staff actions under a shared key. It has no person ID.

## Options Considered

### Option A: Permission names, four fixed roles mapped in code, checked on every route

- **Permission names:** each capability has a dotted name, such as `billing.read`, `billing.export`, `billing.write`, `support.lookup`, `support.reveal`, `account.suspend`, `requests.decide`, `campaign.write`, `staff.manage`, `audit.read` and `metrics.read`.
- **Roles in code:** a table in `server/src/staff/permissions.ts` maps `owner | support | billing | viewer` to permission sets, so changes go through pull-request review.
- **Server checks:** each route declares the permission it needs (`requirePermission('billing.export')`), and the server is the only authority.
- **UI:** `GET /staff/me` returns the person's permissions, and the UI shows only those menu items and buttons.

**Pros:**
- Fine-grained.
- New sections add permission names without new roles.
- Easy to test: one table-driven test covers every route against every role.
- Nothing to misconfigure at runtime.

**Cons:**
- Changing what a role can do needs a deploy.

### Option B: Editable roles and permissions in the database (custom roles in the UI)

**Pros:**
- Flexible without a deploy.

**Cons:**
- A runtime escalation path: anyone with "manage roles" can grant themselves anything.
- More UI and tests to build.
- Not needed for a small team (YAGNI).

### Option C: Role checks only (`role === 'owner'`) with no permission names

**Pros:**
- Simplest.

**Cons:**
- Role checks scatter through the code.
- Adding a role or splitting a capability means touching every check.
- Fails the "fine-grained and extensible" goal.

## Decision

**We chose Option A.** It meets "fine-grained yet simple":
- staff see only four roles, while the code checks precise permissions;
- the mapping lives in reviewed code, so no runtime screen can be used to escalate.

The table moves to the database later only if the team outgrows four roles. Routes keep calling `requirePermission`, so that move doesn't change them.

**Database users.** There are three, so the grants mean something on MySQL:

| User | Allowed |
|---|---|
| `migrator` | Owns the schema (DDL). Used only by migrations. |
| `app` | The mobile API. No rights on the `staff_*` tables or `admin_audit_log`. |
| `staff` | The staff API. `INSERT`, `SELECT` on `admin_audit_log`. Read and write on the `staff_*` tables. Read on the account, household, billing and campaign tables. Update limited to the suspend flag, the request status and the campaign settings. No access to vault, journal or chat ciphertext. |

The app processes never get DDL, `TRIGGER` or `DROP` rights.

**Audit log.**
- **What is logged:**
  - `admin_audit_log` gains `staff_user_id`, with a foreign key `ON DELETE RESTRICT` (staff are deactivated, never deleted). The column is null only for old shared-key rows.
  - One middleware writes an entry for every staff request that changes data or reads personal data (lookups, reveals, CSV exports), plus every sign-in, failed sign-in, step-up and rate-limit hit.
  - Each entry records permission, action, target type and ID, result, request ID, IP and user agent, a server timestamp, and a `detail` JSON built from an allow-list of fields per action.
- **Hash chain:**
  - Each row stores `prev_hash` and `hash`. The hash is SHA-256 over length-prefixed fields, starting from a fixed first value.
  - Writes take a row lock on a single `audit_chain_head` row, so concurrent inserts can't fork the chain.
  - A nightly job checks the chain and writes the latest hash to a versioned S3 object outside the database. The audit page shows the last check.
  - The `INSERT`/`SELECT`-only grant is the real protection. The chain and the external copy make an edit by someone with database-admin rights visible later.
- **Never logged:** in request logs and audit details, these are redacted:
  - headers: `cookie`, `set-cookie`, `authorization`, `cf-access-jwt-assertion`;
  - body fields: `assertion`, `challenge`, `inviteToken`;
  - full email and phone. Only the target ID is logged.

**Personal data.**
- **Masking in the API:** lookup and search responses return masked email and phone (`a•••@example.com`). The UI never receives the full value by default.
- **Reveal:** `POST /support/:userId/reveal` (`support.reveal`, step-up) returns one field and writes an audit entry with the target ID.
- **Search:** "Find anything" results are filtered by the caller's permissions, so a viewer never sees households.
- **Caching:** every staff API response is sent with `Cache-Control: no-store`.
- **CSV exports:**
  - capped at 50,000 rows;
  - no email or phone columns;
  - every cell that starts with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with `'`;
  - each export is audited with its filters and row count.

## Consequences

**Easier:**
- Answering "who did this?"
- Proving the log wasn't touched.
- Adding a section: new permissions plus one row each in the role table and its test.

**Harder:**
- Three database users and their grants are an operations step and go in the runbook. Integration tests check that the `staff` user cannot update or delete an audit row, and that the `app` user cannot read `staff_*` tables.
- A role change needs a deploy, which is intended.

**If superseded:**
- Moving the mapping to the database replaces `permissions.ts` with a table and an admin screen.
- `requirePermission` and the audit middleware stay the same.
