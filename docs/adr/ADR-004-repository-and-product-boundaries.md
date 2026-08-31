# ADR-004 — Messages Data Plane / GMweb Control Plane + PWA / Eve Business Plane

**Status:** Accepted (product boundary decision, authoritative over the TechSpec
§5 web project structure where they conflict)
**Date:** 2026-08-31
**Repos:** aibedini/Messages · aibedini/GMweb-API · aibedini/eve

## Context

The platform now has three repositories and a rising risk of boundary drift:
Web/PWA code inside the Android repo, or the business plane reaching into the
control plane's data. The RFP/TechSpec assumed a future separate web repo; the
owner has instead decided to keep the ecosystem to its existing three repos.

## Decision

**No fourth repo. Three planes with explicit ownership:**

| Repo | Plane | Owns |
|---|---|---|
| `aibedini/Messages` | **Android Data Plane** | Telephony, SMS/MMS, SIM/SMSC, delivery evidence, Room, Android device identity, durable event outbox, durable command inbox, command execution. **Web code never enters Messages.** |
| `aibedini/GMweb-API` | **Messaging Control Plane + Secure Web/PWA** | Authentication, Passkeys, Sessions, Device Registry, Signed Trust Registry relay, Commands, Sync, encrypted event store, SSE, Web Push, Audit, PWA, HeroUI Design System. The PWA lives here as an **independent application/deployable** (`web/`), NOT a rewrite of `dashboard-next` (which remains the legacy console until retirement). |
| `aibedini/eve` | **Business / Automation Plane** | VPN/business domain, billing, resellers, templates, automation triggers, business workflows. Eve is a **machine/service client** of GMweb with limited capability service identity (e.g. `SEND_SMS_AUTOMATION`, `READ_SEND_STATUS`) — by default NOT inbox-decrypt capable. |

### Integration topology (the ONLY topology)

```text
PWA ─────┐
         │
Eve ─────┼──► GMweb ◄──► Messages Android Agent
         │
future ──┘
```

No PWA→Android direct protocol. No Eve→Android protocol. **GMweb is the only
Control Plane.**

### Transports inside GMweb Messaging Core

```text
GMweb Messaging Core
├── Android Agent Transport     # strategic/default
└── Google Web Transport       # legacy compatibility adapter
```

The existing Chrome/Playwright Google-Messages transport is kept as a **Legacy
Transport Adapter** — never removed abruptly, never the strategic path.

### Eve migration — non-breaking

Existing `POST /send` becomes a **compatibility adapter over the new command
engine**; only afterwards does Eve migrate to `/api/v1/commands` + service
identity. **Early Phase 2 PRs must not break Eve production flows.**

## Consequences

- Same repository ≠ same runtime: `web/` and the API get independent
  artifacts, CI and deployments.
- Cross-repo schemas/protocols must respect this ownership: Android owns data
  truth, GMweb owns control, Eve consumes as a client.
- `packages/contracts` + `packages/protocol` become the shared contract
  surface between the planes (versioned, test-pinned both sides).
- The TechSpec Phase 4 (Web Foundation) now executes as `GMweb-API/web/`
  (React + TS + Vite + HeroUI v3 + Tailwind v4 + IndexedDB + WebCrypto + SW +
  Web Push + SSE) with the §7 screens; `dashboard-next` retires only after
  parity.
- Early decisions inherited by all planes: ADR-001..003 (trust root, CKE,
  availability SLO) remain binding on GMweb and Eve work too.
