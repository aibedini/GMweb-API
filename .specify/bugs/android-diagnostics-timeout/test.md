# Bug Verification: Android diagnostic timeout

- **Slug:** android-diagnostics-timeout
- **Result:** partial (real phone pending)

The old route used twelve scans. After deploying the grouped query, a cold production run took 26.8 seconds over 1,127,103 events: the query still read table pages and exceeded Android's 15-second timeout. A covering metadata index was therefore added. Building that index on the production ledger took 38.9 seconds; the exact `diagnosticStats` function then completed in 884 ms on the same ledger. `EXPLAIN QUERY PLAN` reports `USING COVERING INDEX idx_events_diagnostics_cover`. Local and CI tests must verify the index and response values. A signed Android Full Test against the deployed revision is NOT VERIFIED.
