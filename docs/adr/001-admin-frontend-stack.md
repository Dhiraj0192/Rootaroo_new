# ADR-001-admin-frontend-stack: React + Vite + TanStack + Tailwind, served as static files behind strict headers

**Status:** Proposed
**Date:** 2026-10-09
**Feature:** 001-admin-panel

## Context

The admin app must be:
- fast;
- simple to use while showing fine detail (tables with filters, detail side panels, a "find anything" search);
- in the Rootaroo design language: Plus Jakarta Sans and JetBrains Mono like rootaroo.com, the navy and honey colours, the app's glass cards, dark only;
- plain static files with strict security headers, with Railway the likely host.

rootaroo.com is built with React, Vite and Tailwind, and the mobile app is React Native, so the team already knows React.

## Options Considered

### Option A: React 18 + Vite + TypeScript, TanStack Router + Query, Tailwind CSS, Radix UI primitives, Lucide icons

| Piece | Job |
|---|---|
| TanStack Router | Typed routes; each section module registers its own routes |
| TanStack Query | Caching, retries and loading states |
| Tailwind | Design tokens copied from the site and `mobile/src/shared/theme` |
| Radix | Accessible dialogs, menus, switches and tabs, with no styling imposed |
| Lucide | The icon set rootaroo.com already uses |
| TanStack Table | Sortable, filterable tables |
| Small inline SVG chart components | Charts that follow our chart rules |

**Hosting:**
- `vite build` produces static files.
- A Caddy container serves them on Railway and sets the security headers:
  - CSP: `default-src 'self'; script-src 'self'; style-src-elem 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Scripts are never allowed inline. `style-src-attr` allows only the inline `style` attributes that Radix sets for positioning, so nobody is tempted to loosen `script-src`.
  - Staff API responses, proxied under `/api`: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
  - HSTS with preload
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy` that blocks the camera, microphone and location
- The same headers ship as a `_headers` file for Cloudflare Pages or Netlify, should the host change.
- Inline scripts are banned in the build (CSP), and assets get hashed filenames.

**Pros:**
- Same stack as rootaroo.com, so tokens and know-how carry over.
- Mature, MIT-licensed and well maintained.
- Small bundle; the panel loads as static assets from a CDN.

**Cons:**
- Several libraries to keep updated.
- Tailwind needs a token setup to stay on-brand.

### Option B: Next.js (server-rendered)

**Pros:**
- Routing and rendering on the server.

**Cons:**
- Needs a Node server, so it's no longer plain static files.
- Server rendering widens the attack surface and adds a second backend next to the staff API.
- A strict CSP without inline scripts is harder.
- Search-engine and first-load gains don't matter for a private staff tool.

### Option C: React Native Web, sharing app components

**Pros:**
- Reuses the mobile app's components.

**Cons:**
- Mobile components don't suit dense desktop tables.
- Weaker web accessibility.
- Bigger bundle.
- Couples the admin to Expo upgrades.

## Decision

**We chose Option A.** It produces plain static files that Railway or any host can serve with the strict headers the owner asked for. It matches rootaroo.com's stack (React, Vite, Tailwind, Lucide, Plus Jakarta Sans), so the design language carries over. Radix and TanStack give accessible, detailed screens without building those parts ourselves.

**Design tokens:**
- `admin/src/theme/tokens.css` follows the PRD palette.
- Charts: a single honey series for amounts, honey shades for cohorts, sage and coral only as status colours with an icon and a label.
- Billing's test mode uses its own blue bar so it can't be mistaken for live.

## Consequences

**Easier:**
- Any static host works, and a host move only changes the deploy config.
- Each section module brings its own routes, menu entry and permission.

**Harder:**
- The CSP must be checked in CI (a build test fails on inline scripts or styles).
- Fonts load from Google Fonts. Self-hosting them later means changing `font-src`.

**If superseded:**
- Section modules depend only on TanStack Query hooks generated from `contracts/`.
- A UI framework swap would rewrite components but not the data layer or the staff API.
