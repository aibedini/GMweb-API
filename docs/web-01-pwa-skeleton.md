# web-01 — Secure PWA skeleton (ADR-004)

**Status:** Shipped (skeleton) · Server route: `/web` · Artifact: `public/web-app/`

## What landed

The NEW secure web client lives in `web/` as an **independent Vite artifact**
inside the GMweb-API repository — per ADR-004: same repo, NOT same runtime
(own deps, own build, own deploy; `dashboard-next` remains the legacy console).

### Stack

- React 19 + TypeScript (strict) + Vite 6
- Tailwind CSS v4 (`@tailwindcss/vite`) with §46 design tokens as CSS
  custom properties (light/dark via `prefers-color-scheme`)
- PWA manifest already wired (`/web/manifest.webmanifest`, standalone)
- Service Worker + Web Push + HeroUI v3 components land with the Phase 4
  screens PR (§5 ordering: shell → screens → realtime → push)

### Served securely

Fastify serves the built artifact under `/web` with a dedicated strict CSP
(TechSpec §20, stricter than the global header hook):

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data:; connect-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
No inline scripts — the hashed Vite output needs none (verified: no
`unsafe-inline`/`unsafe-eval` anywhere in the policy).

### Screens shipped (web-01)

1. **Sync** — cursor status, "Sync now" against `GET /api/v1/sync?after=`
   (LOCK 10 per-account sequences), last 50 opaque ciphertext events listed
2. **Trust** — Android-signed snapshot viewer (`trustSequence`, `rootPublicKey`,
   updatedAt) from `GET /api/v1/trust/snapshot`
3. **Debug** — health check + local IndexedDB reset

### Sync engine (web-01 core)

`web/src/lib/sync.ts`: IndexedDB store keyed by **server sequence**
(idempotent replay-safe), transactional page application, `nextCursor`
persistence, and a single `applyEvent()` choke point where Phase 7
decryption plugs in. Payloads stay opaque end-to-end until then (Rule 6).

## Build & run

```bash
npm --prefix web install
npm --prefix web run build     # → public/web-app/ (served at /web)
npm --prefix web run dev       # dev server, /api proxied to :3030
```

## Deliberately NOT here yet

- Passkey login (Phase 4 — the PWA currently rides the same auth gate family
  as the legacy consoles until its own session layer lands)
- SSE invalidation + Web Push (next PRs)
- HeroUI v3 component adoption (design system PR follows the shell)
