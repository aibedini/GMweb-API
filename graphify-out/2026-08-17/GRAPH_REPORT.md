# Graph Report - GoogleMEssage  (2026-08-17)

## Corpus Check
- 82 files · ~83,867 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1457 nodes · 4213 edges · 90 communities (72 shown, 18 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 525 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `05e3ff58`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- GoogleMessagesClient
- GMweb API HTTP bridge
- pc
- server.js
- scripts
- config.js
- gmweb-menu.sh
- ApiKeyStore
- SendQueue
- public-dashboard.sh
- requireToken
- createDashboardSession
- uninstall.sh
- export-openapi.js
- generate-openapi.js
- sendFlow.test.js
- ubuntu22.sh
- pairing-vnc.sh
- vps-chrome.sh
- startSendWorker
- index-C7h9QJI0.js
- r
- d
- app.js
- quick-install.sh
- a
- i
- constructor
- types.ts
- start
- la
- is
- compilerOptions
- SendStore
- get
- e
- dependencies
- SendPacingController
- react
- compilerOptions
- dependencies
- priorityForJob
- devDependencies
- kd
- mount
- then
- Answers to §6 checklist
- Go
- Conversations.tsx
- قرارداد GMweb برای پروژه Eve: اولویت ارسال، feeder اطلاعیه و وضعیت تحویل
- dashboard-next/package.json
- plugins
- QueuePage
- ApiKeysPage
- HistoryPage.tsx
- Overview.tsx
- package.json
- On
- Lu
- browser-probe.js
- doctor.js
- openLoginChrome.js
- card.tsx
- Settings.tsx
- Project agent instructions
- React + TypeScript + Vite
- App.tsx
- badge.tsx
- button.tsx
- Controls.tsx
- Logs.tsx
- gmweb-monitor.sh
- hash-password.js
- smoke.js
- Shell.tsx
- useSSE.ts
- tsconfig.json
- @radix-ui/react-slot
- @types/node
- @types/react-dom
- @vitejs/plugin-react
- copilot-instructions.md
- pre-commit
- new-token.js

## God Nodes (most connected - your core abstractions)
1. `i()` - 112 edges
2. `r()` - 93 edges
3. `n()` - 91 edges
4. `t()` - 88 edges
5. `GoogleMessagesClient` - 85 edges
6. `a()` - 74 edges
7. `s()` - 55 edges
8. `o()` - 51 edges
9. `la()` - 45 edges
10. `constructor()` - 44 edges

## Surprising Connections (you probably didn't know these)
- `Dashboard embedded VNC console` --semantically_similar_to--> `VNC/noVNC pairing flow`  [INFERRED] [semantically similar]
  public/dashboard/index.html → docs/SIMPLE_SETUP.md
- `GMweb API HTTP bridge` --conceptually_related_to--> `GMweb`  [INFERRED]
  README.md → CLAUDE.md
- `GMweb Dashboard UI` --references--> `GET /conversations endpoint`  [INFERRED]
  public/dashboard/index.html → docs/API.md
- `POST /send endpoint` --shares_data_with--> `BullMQ send queue (queue.js)`  [INFERRED]
  docs/API.md → CLAUDE.md
- `GMweb API endpoints reference` --references--> `Auth model (master token vs project key)`  [INFERRED]
  docs/API.md → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **OpenAPI contract sync flow** — claude_openapi_generation, docs_integration_openapi_json, docs_api_health, docs_integration_docs_json, docs_integration_consumer [EXTRACTED 1.00]
- **Headless VPS pairing stack** — docs_vps_no_gui_xvfb, docs_simple_setup_vnc_pairing, docs_vps_no_gui_connect_mode, docs_operations_browser_profile [INFERRED 0.85]
- **Message send pipeline** — docs_api_send, claude_queue_js, claude_redis, claude_google_messages_client [INFERRED 0.85]

## Communities (90 total, 18 thin omitted)

### Community 1 - "GMweb API HTTP bridge"
Cohesion: 0.07
Nodes (46): Project API keys (apiKeys.js), Auth model (master token vs project key), Chromium / Playwright browser, Env config (config.js), API contract sync policy, GMweb, googleMessagesClient.js Playwright automation, Master token (API_TOKEN) (+38 more)

### Community 2 - "pc"
Cohesion: 0.06
Nodes (86): Ac(), ao(), at(), ba(), bc(), bu(), cd(), cf() (+78 more)

### Community 3 - "server.js"
Cohesion: 0.04
Nodes (55): activeSendCancellationRequests, ADMIN_ONLY_PREFIXES, ANNOUNCEMENT_PENDING_LIMIT, { ApiKeyStore }, authFailBuckets, backfillPendingLedger(), browserRecoveryFile, browserRecoveryLogFile (+47 more)

### Community 4 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, check, dev, doctor, export:openapi, generate:openapi, hash-password, login (+5 more)

### Community 5 - "config.js"
Cohesion: 0.20
Nodes (4): dotenv, fs, path, rootDir

### Community 6 - "gmweb-menu.sh"
Cohesion: 0.13
Nodes (33): adopt_git_checkout(), api_accepts_token(), dashboard_credentials(), logs(), menu_loop(), need_root(), pause(), pause_and_drain_queue() (+25 more)

### Community 7 - "ApiKeyStore"
Cohesion: 0.17
Nodes (5): ApiKeyStore, crypto, fs, hashToken(), safeEqual()

### Community 9 - "public-dashboard.sh"
Cohesion: 0.36
Nodes (9): install_public_dashboard(), need_root(), remove_public_dashboard(), set_env_value(), public-dashboard.sh script, show_credentials(), status_public_dashboard(), usage() (+1 more)

### Community 10 - "requireToken"
Cohesion: 0.24
Nodes (11): applySecurityHeaders(), bearerToken(), csrfAllowed(), hasDashboardAccess(), isAdminOnlyPath(), isAuthBlocked(), isDashboardAsset(), recordAuthFailure() (+3 more)

### Community 11 - "createDashboardSession"
Cohesion: 0.25
Nodes (11): cleanupDashboardSessions(), clearDashboardSession(), createDashboardPasswordSession(), createDashboardSession(), dashboardPasswordSession(), dashboardSession(), parseCookies(), passwordAuthEnabled() (+3 more)

### Community 12 - "uninstall.sh"
Cohesion: 0.46
Nodes (7): confirm(), maybe_purge_packages(), remove_commands(), remove_files_and_user(), remove_public_dashboard(), remove_services(), uninstall.sh script

### Community 13 - "export-openapi.js"
Cohesion: 0.40
Nodes (5): baseUrl(), fs, main(), path, rootDir

### Community 14 - "generate-openapi.js"
Cohesion: 0.33
Nodes (5): fs, main(), path, rootDir, app

### Community 15 - "sendFlow.test.js"
Cohesion: 0.11
Nodes (18): { chromium }, { EventEmitter }, fs, normalizeComparableMessage(), path, sendGate(), sendSchedule(), zonedClock() (+10 more)

### Community 16 - "ubuntu22.sh"
Cohesion: 0.83
Nodes (3): as_app_user(), set_env_value(), ubuntu22.sh script

### Community 19 - "startSendWorker"
Cohesion: 0.27
Nodes (15): deferConversationJob(), deferQuietHoursJob(), emitSse(), handleSendCompleted(), isBrowserAutomationWedge(), isDelayedRetryJob(), isPairingReadinessFailure(), postWebhook() (+7 more)

### Community 20 - "index-C7h9QJI0.js"
Cohesion: 0.04
Nodes (51): addVariantChild(), ai(), animation(), Bi(), bn(), t(), Ce(), componentDidUpdate() (+43 more)

### Community 21 - "r"
Cohesion: 0.10
Nodes (48): add(), ae(), ap(), b(), bindToMotionValue(), Bo(), C(), D() (+40 more)

### Community 22 - "d"
Cohesion: 0.12
Nodes (44): Bd(), cm(), E(), Er(), gp(), ae(), ce(), k() (+36 more)

### Community 23 - "app.js"
Cohesion: 0.12
Nodes (41): api(), bind(), buildApiKeyRow(), buildMessageDivs(), cancelJob(), cleanText(), compactState(), connectSSE() (+33 more)

### Community 24 - "quick-install.sh"
Cohesion: 0.18
Nodes (40): ask(), banner(), change_dashboard_password(), configure_timezone(), confirm(), do_full_install(), do_uninstall(), err() (+32 more)

### Community 25 - "a"
Cohesion: 0.15
Nodes (37): Al(), cl(), cr(), Cu(), Dl(), ea(), ep(), fd() (+29 more)

### Community 26 - "i"
Cohesion: 0.11
Nodes (32): Aa(), br(), bt(), ct(), dp(), fp(), Ft(), s() (+24 more)

### Community 27 - "constructor"
Cohesion: 0.08
Nodes (31): attachTimeline(), constructor(), dirty(), Dr(), end(), finish(), handleScroll(), initAnimation() (+23 more)

### Community 28 - "types.ts"
Cohesion: 0.09
Nodes (25): api(), ApiError, csrfToken, Options, setCsrfToken(), setUnauthorizedHandler(), Ctx, SessionProvider() (+17 more)

### Community 29 - "start"
Cohesion: 0.16
Nodes (30): addListeners(), Au(), cancel(), cc(), clearAnimation(), commitStyles(), Du(), ei() (+22 more)

### Community 30 - "la"
Cohesion: 0.13
Nodes (26): attach(), Da(), fi(), getVelocity(), Ia(), ja(), Ka(), la() (+18 more)

### Community 31 - "is"
Cohesion: 0.13
Nodes (26): Bl(), bs(), build(), cs(), gd(), Ho(), hs(), Il() (+18 more)

### Community 32 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+15 more)

### Community 33 - "SendStore"
Cohesion: 0.11
Nodes (6): crypto, Database, dedupeKey(), fs, path, SendStore

### Community 34 - "get"
Cohesion: 0.23
Nodes (23): af(), Bf(), get(), If(), jf(), kf(), Mf(), ml() (+15 more)

### Community 35 - "e"
Cohesion: 0.12
Nodes (22): complete(), duration(), getGeneratorVelocity(), hr(), iterationDuration(), measureEndState(), measureInitialState(), measureInstanceViewportBox() (+14 more)

### Community 36 - "dependencies"
Cohesion: 0.10
Nodes (21): better-sqlite3, bullmq, dotenv, fastify, @fastify/cors, @fastify/http-proxy, @fastify/swagger, @fastify/swagger-ui (+13 more)

### Community 37 - "SendPacingController"
Cohesion: 0.15
Nodes (12): clampInteger(), DEFAULT_SETTINGS, fs, normalizeSendPacingSettings(), path, SendPacingController, assert, fs (+4 more)

### Community 38 - "react"
Cohesion: 0.10
Nodes (7): Login(), Input, Label, SpotlightCard(), Textarea, SendPage(), react

### Community 39 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, noEmit, noFallthroughCasesInSwitch (+11 more)

### Community 40 - "dependencies"
Cohesion: 0.11
Nodes (19): class-variance-authority, clsx, dependencies, class-variance-authority, clsx, framer-motion, lucide-react, @radix-ui/react-dialog (+11 more)

### Community 41 - "priorityForJob"
Cohesion: 0.15
Nodes (9): connection, { normalizeSendPriority, priorityForJob }, { Queue, Worker, QueueEvents }, normalizeSendPriority(), PRIORITY_LEVELS, PRIORITY_NAMES, priorityForJob(), priorityNameFromNumber() (+1 more)

### Community 42 - "devDependencies"
Cohesion: 0.12
Nodes (17): autoprefixer, devDependencies, autoprefixer, oxlint, postcss, tailwindcss, tailwindcss-animate, @types/react (+9 more)

### Community 43 - "kd"
Cohesion: 0.21
Nodes (17): Ad(), ar(), gf(), ir(), jd(), jr(), kd(), Nd() (+9 more)

### Community 44 - "mount"
Cohesion: 0.19
Nodes (15): createPanHandlers(), dd(), handleChildMotionValue(), hd(), jump(), mount(), onBlur(), onFocus() (+7 more)

### Community 45 - "then"
Cohesion: 0.17
Nodes (15): ds(), fm(), fs(), ga(), getDefaultTransition(), ha(), isAnimating(), ls() (+7 more)

### Community 46 - "Answers to §6 checklist"
Cohesion: 0.14
Nodes (13): 0) Most important architectural fact (read first), 1. Delivery reports (DLR), 2. `/send` id — exact current response, 3. Webhook, 4. Polling — exact current response, 5. Error codes, 6. Rate limits, 7. Idempotency (+5 more)

### Community 47 - "Go"
Cohesion: 0.23
Nodes (14): addValue(), as(), ca(), Fa(), getStaticValue(), getValue(), Go(), hasValue() (+6 more)

### Community 48 - "Conversations.tsx"
Cohesion: 0.26
Nodes (11): Avatar(), AVATAR_COLORS, avatarColor(), ConversationsPage(), load(), loadThread(), onListScroll(), openConv() (+3 more)

### Community 49 - "قرارداد GMweb برای پروژه Eve: اولویت ارسال، feeder اطلاعیه و وضعیت تحویل"
Cohesion: 0.17
Nodes (11): 10. معیار پذیرش پیاده‌سازی Eve, 1. مرز مسئولیت دو سرویس, 2. احراز هویت و endpointها, 3. مدل چهارسطحی priority, 4. ثبت پیام, 5. ظرفیت announcement, 6. state machine پیشنهادی در Eve, 7. خواندن نتیجه و سیاست retry (+3 more)

### Community 50 - "dashboard-next/package.json"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, preview, type (+1 more)

### Community 51 - "plugins"
Cohesion: 0.22
Nodes (8): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema, oxc, typescript, warn

### Community 52 - "QueuePage"
Cohesion: 0.39
Nodes (8): elapsed(), QueuePage(), cancel(), messageFor(), performBulkAction(), promote(), releaseDelayedHigh(), togglePaused()

### Community 53 - "ApiKeysPage"
Cohesion: 0.43
Nodes (5): ApiKeysPage(), create(), load(), remove(), toggle()

### Community 54 - "HistoryPage.tsx"
Cohesion: 0.43
Nodes (5): dateTime(), FILTERS, HistoryPage(), SendRecord(), statusStyle()

### Community 56 - "package.json"
Cohesion: 0.33
Nodes (5): description, main, name, private, version

### Community 57 - "On"
Cohesion: 0.40
Nodes (6): An(), Dn(), getSize(), kn(), Nn(), On()

### Community 58 - "Lu"
Cohesion: 0.33
Nodes (6): clear(), clearListeners(), destroy(), Iu(), Lu(), unmount()

### Community 59 - "browser-probe.js"
Cohesion: 0.40
Nodes (5): { chromium }, finish(), hardTimer, startedAt, timeoutMs

### Community 60 - "doctor.js"
Cohesion: 0.40
Nodes (5): check(), config, fs, main(), pkg

### Community 61 - "openLoginChrome.js"
Cohesion: 0.33
Nodes (5): args, child, config, fs, { spawn }

### Community 62 - "card.tsx"
Cohesion: 0.40
Nodes (4): Card, CardContent, CardHeader, CardTitle

### Community 63 - "Settings.tsx"
Cohesion: 0.40
Nodes (3): SendPacingSettings, SettingsPage(), SettingsResponse

### Community 64 - "Project agent instructions"
Cohesion: 0.50
Nodes (3): API contract, Codebase Memory is mandatory, Project agent instructions

### Community 65 - "React + TypeScript + Vite"
Cohesion: 0.50
Nodes (3): Expanding the Oxlint configuration, React Compiler, React + TypeScript + Vite

### Community 67 - "badge.tsx"
Cohesion: 0.67
Nodes (3): Badge(), BadgeProps, badgeVariants

### Community 68 - "button.tsx"
Cohesion: 0.67
Nodes (3): Button, ButtonProps, buttonVariants

### Community 71 - "gmweb-monitor.sh"
Cohesion: 1.00
Nodes (3): close_rotation(), log(), gmweb-monitor.sh script

### Community 72 - "hash-password.js"
Cohesion: 0.50
Nodes (3): crypto, derived, salt

### Community 73 - "smoke.js"
Cohesion: 0.67
Nodes (3): config, main(), request()

## Knowledge Gaps
- **266 isolated node(s):** `$schema`, `typescript`, `oxc`, `react/rules-of-hooks`, `warn` (+261 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GoogleMessagesClient` connect `GoogleMessagesClient` to `server.js`, `sendFlow.test.js`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `react` connect `react` to `App.tsx`, `button.tsx`, `Controls.tsx`, `Logs.tsx`, `Shell.tsx`, `useSSE.ts`, `Conversations.tsx`, `plugins`, `QueuePage`, `ApiKeysPage`, `HistoryPage.tsx`, `Overview.tsx`, `types.ts`, `card.tsx`, `Settings.tsx`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Are the 31 inferred relationships involving `i()` (e.g. with `Ac()` and `ap()`) actually correct?**
  _`i()` has 31 INFERRED edges - model-reasoned connections that need verification._
- **Are the 59 inferred relationships involving `r()` (e.g. with `ae()` and `Al()`) actually correct?**
  _`r()` has 59 INFERRED edges - model-reasoned connections that need verification._
- **Are the 58 inferred relationships involving `n()` (e.g. with `index-C7h9QJI0.js` and `add()`) actually correct?**
  _`n()` has 58 INFERRED edges - model-reasoned connections that need verification._
- **Are the 40 inferred relationships involving `t()` (e.g. with `Al()` and `br()`) actually correct?**
  _`t()` has 40 INFERRED edges - model-reasoned connections that need verification._