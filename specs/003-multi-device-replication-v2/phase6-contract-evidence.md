# Phase 6 cross-repository contract evidence

Feature ID: `multi-device-replication-v2`. On 2026-09-24, the public
`aibedini/Messages` HEAD `c5d43e53374ee6844b2f683bb14e5a898ad4e34e`
was checked out for read-only comparison.

| Fixture | GMweb Git blob | Android Git blob | Result |
| --- | --- | --- | --- |
| `pairing-protocol-v1.json` | `314f0be199220be1275495dcbb5681ef1e588798` | same | MATCH |
| `messages-web-replication-v3.json` | `67cc11d9f611de2fee81c088f877d48113a20b83` | same | MATCH |

The Windows working-tree files have different CRLF/LF bytes, so the comparison
above uses canonical committed Git blobs. Linux CI now byte-compares both
checked-out fixtures. The physical release report must match hashes of both
local fixtures and the exact server/APK artifacts; a synthetic report cannot
satisfy its required physical-device steps.

This is evidence of shared fixture identity and V1/V3 payload compatibility,
not Android adoption of V2 ingest or V2 command leases. Searching the checked-out
Android application for `batch-v2`, `claim-v2`, `status-v2`, and `snapshot-v2`
found no route usage. V2 lease activation and modem-boundary deduplication remain
NOT VERIFIED and disabled. No physical APK, browser, or modem acceptance was run.
