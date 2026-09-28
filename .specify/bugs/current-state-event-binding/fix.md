# Bug Fix: Current-state event identity

- **Slug:** current-state-event-binding
- **Status:** applied
- **Cross-repository feature ID:** android-web-recovery-v1

The browser current-state adapter extracts the original public event ID from the encrypted envelope. Malformed envelopes retain a synthetic fallback and still fail in the crypto validator. A test checks conversation and message state mapping.
