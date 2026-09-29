# Assessment: prior pairing history grants block current keyring

Date: 2026-09-29. Severity: high. Verdict: valid.

Production read-only aggregate evidence: the current linked session is pinned to trust sequence 56 while GMweb retains `HISTORY_KEY_GRANT` events for the same stable browser at sequences 48, 51, 54, and 56. The browser's `receiveKeyGrantPage` rejects each older grant because its binding does not equal the current certificate. `runKeySync` aborts the whole page on the first rejected result, so its cursor remains behind and the Inbox reports `KEY_SYNC` degradation even though the sequence-56 grant can decrypt current messages.

The older grants are legitimate records from revoked/replaced pairings. They cannot authorize the current session. The desired behavior is to skip grants with a lower trust sequence, continue to verify and install the current signed grant, and keep same-sequence binding mismatches invalid. Do not weaken root-signature checks for an installable grant.
