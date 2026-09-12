# Messages-for-Web Remediation RFP Matrix

Date: 2026-09-12. Source code is authoritative. Starting points: Messages `81efa37`; GMweb-API `7030227`.

Status meanings: **DONE** = implemented and covered by available automated checks; **PARTIAL** = implementation exists but a required environment validation or operational item remains; **NOT RUN** = no valid environment was available; **NOT DONE** = an implementation gap remains.

## Priority requirements

| RFP item | Status | Evidence / remaining gate |
|---|---|---|
| P0-1A central event crypto policy | DONE | Shared JSON fixture, Android mirror, server/Web modules and parity tests. |
| P0-1B Android fail-closed | DONE | `GatewayEventFactory` and `EventUploader` reject injected v0 content before HTTP. |
| P0-1C server fail-closed | DONE | Batch route validates required fields, allowlist, canonical Base64, envelope binding and bounds before storage. |
| P0-1D Web fail-closed | DONE | Unsupported/v0 content is rejected before persistence, projection and rendering. |
| P0-2 browser plaintext purge | DONE | IndexedDB v7 clears legacy projections/v0 content and handles empty bootstrap while preserving identity keys. |
| P0-3 replica generation | DONE | Persistent metadata, bootstrap/sync identity and mismatch rebootstrap test. |
| P0-4 all SMS + sensitive capability | PARTIAL | Explicit category grants and replay are implemented/tested; real two-browser/device proof is NOT RUN. |
| P0-5 ingest hard limits | DONE | 100 events, 800 KiB body, 512 KiB aggregate, per-event/ID bounds and strict Base64 tests. |
| P0-6 security canary | PARTIAL | Automated SQLite/API/log/IndexedDB canary PASS; deployed SQLite/WAL/proxy/browser/network inspection is NOT RUN. |
| P1-1 backfill ACK checkpoints | DONE | Room v11 separates producer and contiguous ACK watermarks; dead letters block completion. |
| P1-2 event-driven uploader | DONE | Room invalidation wake, conflated signal and two-second reliability fallback; realtime priority retained. |
| P1-3/3A/3B/3C compaction | DONE | Durable browser ACK, bounded ACK-gated compaction, retention floor, key/contact preservation and `snapshot_required`. |
| P1-4 secure warm start | DONE | Cache preparation and auth are parallel; cached encrypted state renders after auth without waiting for delta. |
| P1-5 real virtualization | DONE | TanStack virtualizer, stable keys and prepend anchor; arbitrary 400/500 slicing removed. |
| P1-6 IndexedDB pagination | DONE | Compound index and server-compatible keyset cursor; 21-page test passes. |
| P1-7 bounded raw event store | DONE | Reconstructable content deltas compact to a 10,000-sequence window; control/key state is retained. |
| P1-8 encrypted Web commands | DONE | Current sensitive command set (`SEND_SMS`, `MARK_THREAD_READ`) requires encrypted linked payloads. |
| P1-9 legacy SSE query token | DONE | PWA uses cookies; production default is disabled and compatibility needs an explicit flag. |
| P1-10 idempotent migration | DONE | Backup-first purge preserves control state, rotates generation and never resets server sequence. |
| P2-1 TLS audit | DONE | Release cloud path is HTTPS-only and no trust-all verifier was found. |
| P2-2 logging audit | PARTIAL | Application logs are sanitized and test logs are canary-checked; deployed logs are NOT RUN. |
| P2-3 performance instrumentation | PARTIAL | Queue depth, ACK lag and compaction/query diagnostics exist; physical latency/memory/battery metrics are NOT RUN. |
| P2-4 query validation | DONE | 360k synthetic plans are index-backed; no UI hot-path OFFSET scan. |

## Cross-cutting sections

| RFP section | Status | Evidence / remaining gate |
|---|---|---|
| 1 final product architecture | PARTIAL | Architecture is implemented; full physical acceptance remains NOT RUN. |
| 2 priorities | DONE | Code-level P0 blockers are closed; physical/deployed validation is explicitly open. |
| 3 contact compaction warning | DONE | Contact events are excluded from compaction and reconstruction is tested. |
| 4 realtime during backfill | PARTIAL | Priority and wake implementation pass automated checks; carrier-to-Web latency is NOT RUN. |
| 5 real-device 360k test | NOT RUN | `adb devices` found no connected device or emulator. |
| 6 required E2E matrix | PARTIAL | Automated crypto/migration/compaction/pagination/revocation cases pass; physical cases remain open. |
| 7 security canary release test | PARTIAL | Automated high-entropy canary PASS; production artifacts are unavailable locally. |
| 8 network inspection | NOT RUN | Requires controlled TLS termination on the deployed data path. |
| 9 performance targets | PARTIAL | Synthetic server targets pass; physical p95/p99 targets are unmeasured. |
| 10 outbox bounds | DONE | Bounded history producer and independent realtime/backfill diagnostics retained. |
| 11 completed-work regression guard | DONE | Partial ACK, keyset pagination, revision UPSERT, SSE wake, cookie auth, HTTPS and reconciliation tests pass. |
| 12 Android change areas | DONE | Existing classes and Room schema were extended without duplicate architecture. |
| 13 GMweb change areas | DONE | Existing server, EventStore and Web structures were extended; OpenAPI regenerated. |
| 14 DB migration requirements | DONE | Room v11 and server migrations are forward/idempotent; Telephony Provider is untouched. |
| 15 P0 definition of done | PARTIAL | All code-level boxes pass; physical sensitive-browser and deployed canary evidence remain open. |
| 16 reliability definition of done | PARTIAL | Automated checkpoint/wakeup/compaction/idempotency checks pass; kill/reboot/backlog proof is open. |
| 17 Web performance definition of done | PARTIAL | Implementation and pagination tests pass; real 30k DOM/memory profiling is NOT RUN. |
| 18 operations definition of done | PARTIAL | Code/config checks pass; production proxy/log/cache inspection is NOT RUN. |
| 19 physical release gate | NOT RUN | See `docs/MESSAGES-WEB-PHYSICAL-GATE.md`. |
| 20 required test commands | PARTIAL | Unit/lint/build/typecheck/security/migration/360k checks pass; instrumentation execution is NOT RUN. |
| 21 security report | DONE | `docs/SECURITY-REMEDIATION-REPORT.md`. |
| 22 performance report | PARTIAL | Synthetic results are recorded; real-device fields remain NOT RUN. |
| 23 architecture update | DONE | ADR documents encrypted flow, watermarks and snapshot/delta semantics. |
| 24 final implementation report | DONE | This matrix and companion reports record hashes, changes, migrations, APIs, tests, limitations and rollback. |
| 25 final acceptance scenario | NOT RUN | Requires the physical/deployed environment from section 19. |

## Latest automated gate

| Check | Result |
|---|---|
| Android `lintDebug` | PASS, zero errors (244 warnings, 3 hints) |
| Android unit tests, instrumentation source compilation, debug/release APK | PASS |
| GMweb `npm run check` | PASS |
| GMweb Node suite | PASS, 235/235 |
| Web production build/typecheck | PASS |
| OpenAPI generation | PASS, v0.18.0, 107 paths; unavailable local Redis emitted non-fatal connection warnings |
| Automated security canary | PASS, zero searched plaintext representations |
| Synthetic 360k benchmark | PASS: 33,249 rows/s; message p95 0.730 ms; conversation p95 0.816 ms; sync p95 4.222 ms |
| Critical SQLite query plans | PASS, index-backed |
| Android instrumentation execution | NOT RUN — no connected device/emulator |
| Physical/deployed release gate | NOT RUN — required hardware/production artifacts unavailable |

## Rollback

Stop the candidate, deploy Messages v3.2.0 and GMweb-API v0.17.0, retain database backups and do not decrement server sequences. Phone/Telephony remains the source of truth. A rollback must not restore plaintext-compatible browser projections; clients should rebuild from encrypted bootstrap after the next forward deployment.
