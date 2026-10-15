# Plan — linked-inbox-actions-v1

Use existing pairing DB session revocation and cookie auth for self unlink. Keep Primary Android as trust authority. Extend linked auth whitelist narrowly for self DELETE and MARK_READ command-key GET. Record content-free read command references in existing activity log; durable command rows retain actor identity across restart.

Load encrypted contacts in background on authentication and sync notifications. Normalize phone lookup consistently; overlay names on conversation projections. Extract one composer component for both empty and existing threads; human-readable SIM and command feedback.

Read commands use existing encrypted MARK_THREAD_READ protocol and Android implementation (SecureCommandPoller -> SmsRepository -> TelephonySyncCoordinator THREAD_READ). Poll completion; apply display acknowledgement only through captured lastSequence. Require visible tab and ready decrypted thread, allow retries after timeout/failure and future sequences.

Constitution: preserve physical truth, durable commands, idempotency, access boundaries and release artifact/version alignment. No customer SMS or production writes. Existing specs/001-final-hardening remain canonical. No schema or cross-repository fixture changes.

Verification: Fastify capability/self-revoke negative tests; contact formatting and read-watermark regressions; full required npm checks; PWA build/artifact verification; interactive synthetic preview if available. Device acceptance remains NOT RUN without a connected test phone.

Tool limitation: graph MCP absent; CLI list_projects fails with secure coordination endpoint error. Source fallback is bounded to touched symbols. Spec Kit skills are read and followed manually; specify executable unavailable. extensions.yml has no registered hooks.
