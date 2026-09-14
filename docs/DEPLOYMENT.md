# Deployment, release integrity and front-end artifacts

This document exists because production once served an API at **0.19.1** with a
PWA at **0.18.0**. Nothing was broken in either build; the release pipeline
simply never rebuilt the front-ends and nothing compared the two versions.

## Artifact policy (explicit)

**Generated front-end bundles are committed AND verified current, and every
deployment rebuilds them for the exact candidate revision.**

| | |
|---|---|
| Committed | `public/web-app/` and `public/dashboard-next/` are in git, so a fresh clone can serve both SPAs immediately. |
| Verified | `npm test` runs `scripts/verify-frontend-artifacts.mjs`. A release candidate whose generated PWA version differs from `package.json` FAILS. |
| Rebuilt | `deploy-gmweb.sh` and `gmweb update` run `npm run build:frontends` for the pinned candidate before anything is promoted or restarted. |

What is **not** committed, because it changes on every build and is not a
release artifact: `*.tsbuildinfo` and `public/web-app/build-info.json`
(build provenance: version, git revision, build time).

The build is byte-deterministic: rebuilding an unchanged revision reproduces the
committed bundles exactly, which is what keeps the working tree clean after a
deployment.

## Canonical build

```bash
npm run build:frontends     # dashboard-next -> public/dashboard-next, web -> public/web-app
npm run build:dashboard     # console only
npm run build:pwa           # PWA only
npm run verify:artifacts    # fails if the artifacts do not belong to package.json
```

`build:frontends` uses `npm ci` in each app (lockfiles, not `npm install`), then
verifies:

* `public/web-app/version.json.version === package.json.version`
* `public/web-app/index.html` exists and **every** referenced `/web/...` asset is on disk
* `public/dashboard-next/index.html` exists and every referenced `/app/...` asset is on disk
* `public/web-app/build-info.json`, when present, agrees with the version

Production can never briefly serve a half-built PWA: the build and the checks
run in a staging copy, and the service is only restarted after they pass.

## Deployment

```bash
# server, ordinary update (menu option 11 calls the same path)
sudo gmweb update

# coordinated release with pairing evidence, from a workstation
GMWEB_DEPLOY_HOST=root@host GMWEB_PUBLIC_ORIGIN=https://host bash deploy-gmweb.sh
```

Both paths build the front-ends for the exact revision and refuse to restart if
the artifacts disagree with the API version.

`deploy-gmweb.sh` order, all in a staging directory until the promote step:

1. checkout must be clean (working tree and index)
2. candidate SHA pinned (`git rev-parse FETCH_HEAD`); never re-fetched afterwards
3. release-evidence gate (`scripts/check-pairing-release.js`)
4. `npm ci --include=dev`, `npm run check`, `npm test`
5. `npm run build:frontends` (+ artifact verification)
6. staged PWA version must equal the candidate `package.json` version
7. promote: `git merge --ff-only`, `npm ci --omit=dev`, rsync the verified artifacts
8. verify the LIVE artifacts, then restart
9. post-deploy: local `/health`, `/web/version.json`, every asset referenced by
   the served `/web` and `/app` entry points (HTTP 200), and `/admin/overview`
   (authorized, token never printed) reporting `matchesApi: true`

## Static cache policy

One implementation: `src/staticCachePolicy.js`.

| Path | Cache-Control | Why |
|---|---|---|
| `/web`, `/web/`, `/app`, `/app/`, any extension-less SPA route | `no-cache, must-revalidate` | The shell is what tells a browser a new build exists. |
| `/web/index.html`, `/app/index.html` | `no-cache, must-revalidate` | Same. |
| `/web/version.json`, `/web/build-info.json`, `/web/manifest.webmanifest` | `no-cache, must-revalidate` | Release metadata. |
| `/web/sw.js` | `no-cache, must-revalidate` | A pinned service worker script would keep an old shell forever. |
| `/web/assets/*`, `/app/assets/*` (content-hashed by Vite) | `public, max-age=31536000, immutable` | Changing a byte changes the file name. |
| everything else (icons, images) | `public, max-age=3600` | Safe short cache; not an entry point. |

The service worker is push/wake-up only and does **not** precache, so it cannot
pin an old shell. That property is intentional — do not add precaching without a
versioned cache name and an activation cleanup.

## Transport health (one source of truth)

`src/transportHealth.js` produces ONE snapshot consumed by `/admin/overview`
and `/admin/transport`, so the two cards on one dashboard refresh cannot
disagree. The old code derived "Delivery" from the active transport and "Device
bridge" from the direct-PUSH android client, which reported "No device" while
the pull bridge was serving the phone.

Source of truth per configuration:

| Transport | Readiness comes from |
|---|---|
| `android` + `pull` | `androidOutbox.readyState()` (`ANDROID_PULL_LIVENESS_MS`, default 90000) |
| `android` + `push` | `androidClient.readyState()` |
| `chrome` | `chromeClient.statusForDashboard()` |

The direct-push client may still be reported, but only under
`alternatives.androidPush` — it never influences pull readiness.

States: `connected`, `stale`, `unconfigured`, `push_unreachable`,
`not_paired`, `unknown`. Reasons: `no_recent_device_pull`,
`device_key_not_configured`, `android_gateway_unreachable`,
`android_gateway_not_configured`, `chrome_not_paired`,
`chrome_probe_failed`. A configured device that went quiet is **stale**, never
**unconfigured**: different operator action.

## Queue now vs delivery outcomes

`/admin/queue` (and `/admin/overview`) separate two different questions:

```jsonc
{
  "queue":  { "waiting": 0, "active": 0, "delayed": 0, "prioritized": 0, "paused": 0,
              "completed": 0, "failed": 0 },        // live BullMQ only
  "idle": true,                                     // waiting + active === 0
  "ledger": {
    "allTime": { "sent": 11213, "unverified": 264, "failed": 683, "superseded": 0, "total": 12160 },
    "last24h": { "sent": 42, "unverified": 1, "failed": 2, "total": 45 }
  },
  "counts": { /* deprecated legacy shape, unchanged for existing clients */ }
}
```

`counts.failed` keeps its historical meaning (all-time ledger failures) for
backward compatibility, which is exactly why new code must read `queue` and
`ledger`. The dashboard renders "Queue now" (live) and "Delivery outcomes —
last 24 hours" separately; an all-time failure total can never make an idle
queue look broken.

Window statistics are computed in SQLite (`sendStore.statsSince(ts)`) with the
additive index `idx_sends_terminal_time`, not by loading rows into JavaScript.
History is never rewritten or purged to make counters look clean.
