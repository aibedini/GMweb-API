# Bug Verification: Current-state event binding

- **Slug:** current-state-event-binding
- **Result:** partial (real browser decrypt pending)

The regression test verifies current-state adapters pass the original envelope event ID for both a conversation and a message. A read-only production sample confirmed both current-state envelope types contain that ID. Web build, artifact verification, and all 481 tests passed. Real-browser decryption is NOT VERIFIED without the primary phone's key and trust replay.
