# Bug Assessment: Linked web sync recovery

## Source and reproduction

The primary phone's Full Test on Android 3.4.15 reports `trust_approval_waiting`, local trust sequence 54, server trust sequence 43, and 1 linked browser. The browser shows `Conversation keys are still pending from the primary phone`, only 100 conversations with an unscrollable side pane, and an incomplete contact book. MMS oldest watermark is repaired. Event outbox remains a separate failing backlog.

## Verdict

Valid, high severity. A waiting approval at the unpublished trust prefix blocks all later signed statements. A browser session at sequence 54 proves a later pairing completed on GMweb, while the trust ledger remains at 43. CSS omits overflow on the conversation pane. The contact bootstrap query starts at the maximum `CONTACTS_SNAPSHOT` sequence, which returns only the final encrypted chunk of a multi-chunk snapshot.

## Root cause and remediation

- Extend the signed primary-agent position response with bounded evidence of approved and still-pending pairings. Android may activate only a matching approved local statement, wait for a live pairing, or root-sign a nonauthorizing void for an abandoned approval. Preserve the original signed approval bytes when confirmed.
- Add a capability-scoped, bounded reverse page for opaque contact events. The browser fetches only on the Contacts tab, decrypts locally until it has a complete snapshot, and applies later changes.
- Give the Inbox side pane a real scroll container and preserve loaded pages during refresh. Show contact sync progress and page visible contact rows.

## Verification needs and risks

Contract/security tests for primary-only evidence and `CONTACTS_READ`; bounded contact page tests; Android approval decision tests; PWA build; production validation after server deployment and Android installation. A live browser/device check is required to prove decryption and complete contact counts. Do not infer carrier delivery or alter historical event outbox rows.
