# Replication V2 acceptance — candidate 0.19.13

Feature ID: `multi-device-replication-v2`. Evidence collected 2026-09-24 from
the GMweb working tree on Windows x64. This is a **candidate**, not production
or physical-device acceptance.

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Syntax and policy | PASS | `npm run check`, exit 0. |
| Unit, contract, restart and simulated concurrency tests | PASS | `npm test`, exit 0; includes V1/V2 ingest, snapshot, key degradation, command lease guards, revocation, and browser cursor tests. Synthetic fixtures only. |
| API schema | PASS | `npm run generate:openapi`, exit 0; `docs/openapi.json` generated for 0.19.13. |
| Frontend build and release artifact version | PASS | `npm run build:frontends` and `npm run verify:artifacts`, exit 0; API and frontend artifacts report 0.19.13. |
| 360,000-message synthetic snapshot | PASS | [Performance report](MESSAGES-WEB-PERFORMANCE-REPORT.md): 360,000 unique snapshot messages, 1 post-baseline realtime event, no snapshot duplicate. In-memory SQLite; not browser/device performance. |
| Shared Android fixtures | PASS for committed blobs | [Cross-repository evidence](../specs/003-multi-device-replication-v2/phase6-contract-evidence.md) at Android `c5d43e5`; CI now compares both fixture files. Android V2 route consumption NOT VERIFIED. |
| Local operational preflight | PASS, limited | `npm run doctor`, exit 0: Node/package, API token, Chrome/profile, disabled debug routes. This is not deployment smoke or send evidence. |
| Physical phone, three-browser, modem dedupe, revocation, deployment | NOT RUN | No `adb` executable or connected test device in this environment; no physical APK or production-like deployment evidence. See [physical gate](MESSAGES-WEB-PHYSICAL-GATE.md). |

Release decision: **BLOCKED for V2 activation**. `commands.leases` stays false.
Provider lease generation guards do not prove Android modem-boundary dedupe or
an exactly-once physical SMS outcome. Real-phone history grant/decryption,
three-browser isolation and the 360k device/browser run remain open. V1 remains
available during staged rollout; no production or zero-downtime claim is made.

Spec Kit integration status was attempted but the `specify` CLI was unavailable
in this environment; the existing feature artifacts and constitution were used.
