# SMS offline queue verification

The HTTP contract test uses an offline Android transport and a fake BullMQ queue. It receives `503` for device readiness with `queueAccepting: true`, then `202` for submission. The worker delays the same job and hands its original request ID to a simulated phone after the phone starts polling. The outbox test checks that an already handed-off task cannot be withdrawn as offline work.

Targeted Android, EVE contract, queue, revocation, transport and frontend artifact tests passed. Syntax, OpenAPI generation and the shared EVE contract check passed. The full suite reached the local execution time limit. A real Android device and production deployment were outside the test environment.
