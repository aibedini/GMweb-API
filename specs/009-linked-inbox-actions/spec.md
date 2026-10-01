# Linked inbox actions

Feature ID: linked-inbox-actions-v1. Date: 2026-09-30.

## User scenarios
1. A linked user signs out this browser and its server sessions stop authorizing reads and writes. Local keys and replica are cleared. Other browsers remain linked; revoking their trust remains a Primary-phone action.
2. Names resolve on the first inbox visit without opening Contacts. Iranian national/international phone forms match. Encrypted contact reconstruction runs independently of first paint.
3. A user opens a ready unread conversation in a visible inbox. A durable read command records the authenticated browser identity, reaches Android, and clears badges after executor completion. Failure and pending states remain visible and retryable. New incoming messages can trigger a new read command.
4. The composer separates text, SIM choice, send action, and status. Missing or stale telemetry explains the phone action required; no SIM or modem evidence is invented.

## Requirements
- FR1: Self unlink deletes all sessions for the authenticated browser identity, clears its cookie and cached data, and denies reuse. No browser may revoke another browser through this route.
- FR2: Contacts load on authentication and sync invalidation when CONTACTS_READ is granted. Names overlay existing projections without changing message data.
- FR3: MARK_READ alone permits command-key retrieval. Read effects run only for the selected ready visible thread and dedupe by message sequence, not forever by thread.
- FR4: After durable acceptance, the browser clears its own viewed unread badge through the submitted sequence and shows phone confirmation as pending. Completed reads confirm the phone state. Pending/failed/expired states do not fabricate a phone read; newer arrivals remain unread.
- FR5: Durable commands retain source_client_id, command id, timestamps and executor result; operational activity records distinguish read requested and executor-completed.
- FR6: Active-primary telemetry is selected by enrolled identity, and missing subscriptions are explicit. Sending continues to require a valid selected active subscription.

## Success criteria
Self unlink rejects replayed session credentials; contacts appear without tab switching; read-only capability can complete a read; fresh unread arrivals are not hidden by older completions; actor identity is recoverable from durable records; composer remains usable at phone and desktop widths.

## Edge cases and assumptions
Offline contacts retain in-memory names. Unsupported older Android telemetry requires an app upgrade, not a web fallback to an unknown SIM. Physical SMS and Android read acceptance require a device; synthetic tests are not production evidence. The user request authorizes implementing UI actions, not revoking an actual session during development.
