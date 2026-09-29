# Fix Report: Legacy batch conflict retry loop

Assessment: `assessment.md`. V1 now exposes the EventStore's already computed per-item outcomes in addition to its unchanged `accepted[]` and `duplicates` fields. The Android parser consumes the additive field. No stored event, ID, sequence, or outbox row is mutated by this API change.
