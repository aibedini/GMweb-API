# Bug Fix: Android diagnostic timeout

- **Slug:** android-diagnostics-timeout
- **Status:** applied
- **Cross-repository feature ID:** android-web-recovery-v1

`EventStore.diagnosticStats()` now computes account and source metrics in one grouped scan. The response fields and privacy boundary remain unchanged. A test covers two source devices, two crypto versions, and an empty account.
