# Fix Report: Linked web sync recovery

Assessment: `assessment.md`. Shared cross-repository ID: `linked-web-sync-recovery`.

GMweb now reports active pairing evidence only to the signed primary agent, and serves opaque contact events in reverse bounded pages only to a linked browser with `CONTACTS_READ`. The PWA reconstructs a complete contact snapshot on demand, displays sync progress, limits rendered contact rows, and makes the conversation pane scrollable with older-page loading. Android 3.4.16 reconciles stranded waiting approvals against server evidence, preserving confirmed certificates and signing empty voids for abandoned rows. The already signed event outbox is not rewritten.

The assessment's candidate paths were sufficient. Production acceptance remains pending deployment and installation.
