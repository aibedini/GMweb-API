# Tasks: Lazy Encrypted Inbox

- [x] T1 Add optional contacts omission to transactional bootstrap and API contract/version/docs.
- [x] T2 Add lazy-mode IndexedDB bootstrap and bounded online/offline page reads.
- [x] T3 Switch PWA startup, SSE, polling and thread page sizes to lazy mode.
- [x] T4 Update diagnostics to report observed current-state mode honestly.
- [x] T5 Add targeted contract/browser/race checks and run repository gates.
- [ ] T6 Build artifacts, merge through protected-main PR, deploy, and collect production-like evidence.

## Analyze result

The spec, plan and tasks agree on an additive API, current-state pagination, no full initial snapshot, trust-preserving browser decryption, and bounded refresh. No constitution conflict found. Implementation may begin.
