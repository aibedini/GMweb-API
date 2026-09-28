# Bug Verification: Android diagnostic timeout

- **Slug:** android-diagnostics-timeout
- **Result:** partial (real phone pending)

The old route used twelve scans. A read-only production query with the replacement grouped SQL completed in 3.46 seconds over 1,127,103 events, below Android's 15-second timeout. Local `npm test` passed 481/481, including two-device and empty-account diagnostic cases. A signed Android Full Test against the deployed revision is NOT VERIFIED.
