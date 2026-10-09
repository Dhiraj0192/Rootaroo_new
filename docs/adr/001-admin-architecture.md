# ADR-001-admin-architecture: Own admin app plus a separate staff API in the existing server

**Status:** Accepted
**Date:** 2026-10-09
**Feature:** 001-admin-panel

## Context

Rootaroo needs a staff admin panel for billing and revenue, household requests and support, campaign switches, metrics, and staff and audit ([PRD](../specs/001-admin-panel/prd.md)). The owner asked for an architecture that is "long term from the initial get go": secure, fast, hostable, and easy to extend with new sections.

Today, staff actions go through two shared keys (`ADMIN_API_KEY` for `/api/v1/admin/*`, `ADMIN_BILLING_API_KEY` for `/api/v1/billing-admin/*`). There are no per-person accounts, and the audit log can't say who did what. The billing staff services (transactions, summary, subscriptions, reconciliation, replay, cohort, routing) and the campaign settings already exist as server code.

Constraints:
- **E2E:** chats, journals and vault files are end-to-end encrypted. The panel must never be able to show content.
- **Hosting:** the server runs on Railway. The admin site must also run on Railway, but stay plain static files that any host can serve.
- **Test vs live:** test and production keys and state must stay separate.

## Options Considered

### Option A: Own React app, plus a separate staff API in the existing server codebase

`admin/` is a TypeScript + React + Vite single-page app built to static files. The server gains a second Express app, the staff API, run as its own process on the private network only. The Caddy container that serves `admin.<domain>` reverse-proxies `/api/*` to it, so the browser sees one origin. The staff API has its own router, rate limits, session middleware and error handling. It reuses the server's Sequelize models and service modules, and never goes through the mobile app's routes. Request and response types live in one shared `contracts/` folder that both sides import.

**Pros:**
- Reuses the billing and campaign services that already exist, so no logic is duplicated.
- The staff surface is isolated from the mobile API at the network level: it has no public address and is reachable only through the admin host behind Cloudflare Access, with its own cookies and database user.
- One deploy pipeline, one migration history, one test setup (including the MySQL integration tests).
- The look matches rootaroo.com and the app, and every screen can be built E2E-safe by design.

**Cons:**
- More UI to build than with a ready-made admin tool.
- The staff API shares a process image with the app API. A server compromise reaches both, the same as today.

### Option B: Ready-made admin tool (AdminJS, Retool, Appsmith)

**Pros:**
- Fastest to first screen.
- CRUD tables come for free.

**Cons:**
- These tools read the database tables directly. They bypass the service layer, where billing rules, reconciliation and campaign safety live.
- Per-person audit is weak or a paid tier.
- Hard to guarantee E2E-safe screens.
- Hosted tools add a vendor that holds production database credentials.
- The look can't follow the Rootaroo design language.

### Option C: Separate admin backend service (own deploy) on the same database

**Pros:**
- Strongest process isolation from the app API.

**Cons:**
- Duplicates the models and services, or needs a shared package extracted first.
- Two deploys and two migration owners that drift apart.
- More infrastructure for a small staff team.

## Decision

**We chose Option A.** It satisfies the long-term goal without new infrastructure:
- the staff API reuses the audited billing and campaign services instead of reading tables;
- it has no public address of its own: it is reachable only through the admin host, which Cloudflare Access protects;
- `admin/` stays plain static files that Railway, or any static host, can serve with strict security headers.

Each panel section is a self-contained module:
- **Server:** `server/src/staff/modules/<section>/`, holding its routes, the permission each route needs, and its validation.
- **Frontend:** `admin/src/modules/<section>/`, exporting its routes, its menu entry and the permission that shows it.

A new section means adding one module on each side; the shell doesn't change.

The process split is deliberate:
- **Production:** two Railway services from one image, set by `PROCESS_ROLE=app|staff`. A crash or rate-limit flood on one doesn't take down the other.
- **Local:** one process may serve both ports.

## Consequences

**Easier:**
- New sections (future campaigns and emails T2/T3, new billing views) slot in as modules.
- Retiring the shared admin keys (T10) is a matter of deleting the old routes once the W7 screens cover them.

**Harder:**
- `admin/` is a third app to keep up to date (dependencies, CI build).
- `contracts/` must stay framework-neutral (plain TypeScript types and zod schemas) so both sides can import it.

**If superseded:**
- A move to Option C would extract `server/src/staff/` and the services it calls into a package.
- The module boundary keeps that extraction mechanical.
