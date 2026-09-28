# Bug Fix: Trust sequence gap

- **Slug:** trust-sequence-gap
- **Status:** applied in GMweb; Android release pending
- **Cross-repository feature ID:** android-web-recovery-v1

GMweb now returns HTTP 409 for a missing or conflicting trust sequence, accepts exact redelivery as a duplicate, and offers the authenticated primary agent a read-only trust position. Android checks the durable receipt and requeues its original signed statements above the server position after a contiguous local audit.
