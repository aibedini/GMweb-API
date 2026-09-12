# Security Remediation Report

Date: 2026-09-12. Scope: current working trees of `Messages` and `GMweb-API`.

## Threat model and invariant

Android is the plaintext source of truth. GMweb is an untrusted durable relay/control plane and must not receive or recover SMS bodies, addresses, contact names, OTPs, or message keys. An authenticated, non-revoked browser may decrypt only after Android grants keys for that browser, origin, trust sequence, and approved capabilities.

## Event crypto compatibility

The authoritative fixture is `shared/event-crypto-policy-v1.json`, mirrored by Android at `protocol/event-crypto-policy-v1.json`.

| Class | Event types | Allowed crypto versions | Confidentiality |
|---|---|---:|---|
| Content | message create/update/status/delete | 1, 2, 3 | encrypted envelope required |
| Content | conversation upsert/delete | 3 | encrypted envelope required |
| Content | thread read | 1, 2, 3 | encrypted envelope required |
| Content | contact snapshot/change | 1, 2 | encrypted envelope required |
| Key control | key/contact grant | 1 | protocol envelope |
| Key control | keyring entry | 2 | protocol envelope |
| Key control | history key grant | 3 | browser/origin-bound protocol envelope |
| Non-content control | device/SIM status | 0, 1 | contains no SMS content |

Android validates immediately before HTTP, GMweb validates before persistence, and Web rejects unsupported content before projection/render. Content does not default or downgrade to v0.

## Browser and server migration

IndexedDB v7 unconditionally clears decrypted conversation/contact projections, removes v0 content events, resets data-plane cursors, and preserves browser identity/key stores. Empty bootstrap still commits the high watermark, replica generation, snapshot version, and migration version. A generation/snapshot mismatch triggers encrypted rebootstrap without deleting browser private keys.

Server metadata persists `replicaGeneration`, `snapshotVersion`, and `minimumAvailableSequence`. Legacy plaintext-compatible server content must be purged operationally and replayed encrypted from Android; GMweb must never encrypt plaintext itself. Server sequence numbers remain monotonic.

Rollback: stop the new service, restore the pre-migration GMweb database backup and matching application build, and keep Android as the authoritative copy. Do not restore a browser v0 cache. If server replica metadata changed, generate a new replica generation and request encrypted Android replay.

## Sensitive-message authorization

Pairing presents explicit, default-off capabilities for OTP, bank-security, password-reset, authentication-code, and financial-notification categories. A `FULL_HISTORY` browser receives the single v3 history key for ordinary messages; sensitive messages remain isolated by v2 capability-domain keys. Capability changes become active only after the signed trust statement is ACKed, then Android re-scans history so newly authorized old sensitive messages can be produced. A browser lacking the category capability cannot receive its key.

## Canary and transport evidence

`test/securityCanary.test.js` creates random high-entropy phone/body sentinels, uploads only a v3 envelope, and searches literal, Base64, URL-encoded, and JSON-escaped forms in serialized SQLite, sync response, sanitized EventStore logs, and browser IndexedDB projections. Result on 2026-09-11: **PASS, zero matches**.

The ingest suite rejects v0 content, malformed/non-canonical Base64, unknown types, invalid versions/IDs, 101 events, decoded payload overflow, aggregate overflow, and raw HTTP bodies over 800 KiB. The raw limit covers 512 KiB decoded data expanded by Base64 (~683 KiB) plus bounded JSON/event metadata.

Production SQLite/WAL, reverse-proxy logs, deployed application logs, TLS-termination captures, browser local/session/CacheStorage, and DOM inspection: **NOT RUN — DEPLOYED ENVIRONMENT REQUIRED**.

Physical pairing, tamper, multi-browser sensitive-capability, revocation, and post-revoke denial: **NOT RUN — PHYSICAL DEVICE REQUIRED**.

## TLS and logging audit

Android production cloud origins remain HTTPS-only and certificate verification uses the platform TLS stack. No trust-all `TrustManager` or permissive `HostnameVerifier` was found in production source. Local LAN HTTP belongs to the on-device gateway/debug surface, not the production GMweb cloud client.

No repository setting disables Node TLS verification. The development shell emitted `NODE_TLS_REJECT_UNAUTHORIZED=0` during package installation; this external environment risk must be removed from production/deployment environments.

Security diagnostics log opaque event/device IDs, counts, states, and error codes only. Request bodies, bearer/session credentials, decrypted payloads, keys, bodies, addresses, and contacts must remain excluded from application and proxy logs.

## Remaining metadata leakage and limitations

GMweb observes event type, opaque identifiers, ciphertext size, revision, server sequence, and ordering timestamps required for indexing. It does not hide traffic volume or timing. Physical and deployed-environment gates above remain open; this report does not claim production readiness.
