# Authority inspection issued one lookup per policy key

## Executive summary

Paged authority inspection still dispatched one native SQL lookup per joined policy key. Batch those fresh lookups inside the original read snapshot while retaining every baseline, chain, fingerprint and policy check.

## Summary

A knowledge recovery correctness case exceeded its framework timeout after several genuine recovery attempts and a cold CLI retry. Safe stage diagnostics showed cumulative work and normal disposal, correcting an earlier cleanup-wait hypothesis. This did not attribute all recovery time to authority inspection. A separate real storage regression established the narrower lookup defect directly.

## Timeline

- The recovery stage receipt measured initial fixture preparation at 5.924 seconds, then original recovery operations at 9.312, 3.279 and 3.243 seconds, followed by a 7.831-second independent CLI retry. The final ordinary open crossed the framework deadline; both resource disposers completed normally.
- Source tracing found three point-lookup loops inside the same authority read snapshot.
- The original work regression read all 388 logical keys but issued 388 native lookup statements against a derived seven-statement bound. Its recorded late-row, fingerprint and baseline corruption scenario passed. The test-only run reported one failure, one pass and twenty-seven assertions.
- After fresh lookup batching, the original authority/adoption/work cohort passed twenty-seven tests and 413 assertions (9/42, 16/343, 2/28). The work test retained all 388 keys while native lookup SQL fell from 388 to seven. The original multi-recovery knowledge case then passed with its unchanged 30,000 ms framework timeout, 56 assertions and 14.858 seconds including cleanup; its earlier stage sample reached 30.222 seconds. These are local samples and an owner work bound, without a platform timing guarantee or attribution of every saved second to lookup batching.

## Root cause

The enumeration helpers page canonical rows, but the joins from stored fingerprints to policy, derived final fingerprints to stored fingerprints and projected domain rows to fingerprints awaited individual reads. One snapshot preserved consistency but did not combine native dispatch. Recovery's necessary repeated ownership checks amplified this work. The regression isolates SQL lookup fan-out; it does not establish how much of the observed recovery wall time belongs to these statements.

## Guardrails

- [x] Machine check: the original `packages/harness/test/storage/authority-inspect-work.test.ts` fails on 388 actual lookup SQL dispatches versus seven, after preserving all 388 requested keys and the exact original head, baseline and recorded transition.
- [x] Machine check: its original negative scenario observes a fresh late policy change in the same writer transaction, a missing or malformed final fingerprint, baseline hash damage, exact rollback/restoration and original error identity.
- [x] Machine check: focused post-change work and negative tests passed two tests and 28 assertions with the same original rows and complete lookup-key coverage.
- [x] Machine check: the complete original authority-journal and authority-adoption suites passed twenty-five tests and 385 assertions, retaining archive, mutation and final COMMIT evidence.
- [x] Machine check: the original multi-recovery knowledge correctness case passed 56 assertions in 14.858 seconds under its unchanged 30-second framework guard. Full platform CI remains separate acceptance.

The [decision](../decisions/implemented/bug-fix/2026-11-14-batch-fresh-authority-coverage-lookups.md) preserves the original snapshot and independent adoption owners. The [test-design guidance](../../.synergy/skill/testing-guide/references/test-design.md) permits a correctness framework timeout that accommodates measured cold preparation and repeated native recovery while still detecting hangs. Product protocol deadlines and the explicit 10,000-message capacity workload's 240-second stage and 600-second total budgets remain distinct acceptance requirements.

## Lessons

Measure native dispatch through the actual owner instead of assuming paged enumeration bounds all work. Keep fresh correctness validation complete, and separate its work regression from measured startup or wall-time acceptance.
