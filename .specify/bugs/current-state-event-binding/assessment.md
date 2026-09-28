# Bug Assessment: Current-state pages use the wrong event identity

- **Slug:** current-state-event-binding
- **Status:** confirmed
- **Cross-repository feature ID:** android-web-recovery-v1

## Symptom

The web Inbox shows encrypted placeholders and an empty/failed selected thread even when GMweb returns encrypted current-state pages and a history key grant exists for the browser.

## Root cause

`conversationStateEvent` and `messageStateEvent` constructed synthetic `eventId` values (`snapshot:...` and `state:...`). The v1-v3 encrypted envelope binds the original event ID into AEAD authentication; `decryptMessage` rejects the synthetic ID. A read-only production sample confirmed current-state envelopes carry their original `eventId` and type.

## Remediation

Extract the original public event ID from each opaque envelope in the browser before decryption. Retain a synthetic fallback only so malformed envelopes fail closed in the existing crypto validator. Add a regression check for both conversation and message states.

## Verification limit

The mapping can be verified locally, but actual browser decryption still requires the primary phone's signed trust root and appropriate key grant in the user's browser. Do not claim a real-device pass until observed.
