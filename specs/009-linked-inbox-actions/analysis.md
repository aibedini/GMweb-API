# Pre-implementation analysis

Spec, plan and task coverage: FR1->T1; FR2->T2; FR3/FR4/FR5->T3; FR6->T4. Each scenario has targeted regression and acceptance evidence planned in T5/T6. No blocking ambiguity: self sign-out is available to every authenticated browser, while unlinking another device's trust remains phone-authorized. Command acceptance is distinct from completed read or physical send. Artifacts coherent enough to implement.

Root causes established before patches: App contacts load only on Contacts tab; contactNames never overlays conversationPage. App read dedupe is permanent per aggregate, starts before READY, and ignores completion. command-key rejects MARK_READ-only browsers. Missing SIM field in screenshot is not proof of a web/Android transport defect; current Android source publishes it, production device state unknown.
