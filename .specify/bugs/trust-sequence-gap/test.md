# Bug Verification: Trust sequence gap

- **Slug:** trust-sequence-gap
- **Result:** partial (Android installation pending)

Local route and registry tests verify 409 for a gap, 200 for exact signed redelivery, primary-agent authorization for the position read, and no sequence advancement on conflict. `npm test` passed 481/481 for the original fix. Real Android 3.4.13 diagnostics then showed `local_trust_sequence_gap`: an earlier failed pairing had consumed a local number. The `android-web-recovery-v1` follow-up signs non-authorizing `TRUST_SEQUENCE_VOIDED` records on the primary phone for absent numbers. A registry test verifies that a void advances the ledger without adding an approved device. Production trust replay beyond sequence 43 and browser decryption remain NOT VERIFIED until Android 3.4.14 runs on the primary phone.
