# Native publication repeated independent storage operations

## Executive summary

Native synchronization added repeated metadata-pair reads and separate storage operations for independently addressable derived rows. Controlled tests identified avoidable SQL dispatches while preserving the original native transaction, fresh authority checks and failure handling. Reducing this work does not establish that the unchanged complete capacity workload meets its wall-time limits.

## Summary

The Linux capacity producer missed its original deadline even with one connection epoch and healthy heartbeats. This observation did not isolate CPU cost, worker IPC, SQLite scheduling or exporter work as the sole cause. The following regressions therefore count actual owner work and verify retained native content before asserting a work budget.

## Timeline

- Thirty-two known-Scope pre-mutation probes read the same native Info/index pair twice. Reusing the original Core validator reduced these fresh pair reads from 64 to 32 and keys from 128 to 64. In the combined native producer fixture, metadata reads changed from 2250 to 1736 after this correction and to 1352 with derived-row bulk publication. The same two transactions and two marker scans remain; delivery metadata reads remain 1061 with thirteen pre-mutation reads. These improvements are neither a halving claim nor a full workload timing result.
- Sixteen original Message/Part writes issued 160 Message-display and 96 Part-display storage mutation statements. Existing bulk publication reduced those counts to 64 and 64: ten to four per Message and six to four per Part. The two display owner cases passed with 84 assertions, and five adjacent files passed with 220 assertions.
- The original sink capture issued eleven SQL dispatches per event. Bulk publication of its sequence metadata and delivery row reduced the actual count to six for all four measured events. The first estimate of four omitted two mandatory fresh RuntimeMaintenance checks; the corrected owning budget retains those checks. The final two sink owning cases passed with 29 assertions, retaining the original failure, sequence and transaction controls.

## Root cause

Each ordinary typed row write repeats prior-row selection, path-node insertion and record insertion. A fresh mutation operation also verifies RuntimeMaintenance: this fixture reads its current pointer and checks that no orphaned maintenance history exists. Two independent sink-row writes therefore cost one sequence selection plus twice five statements, or eleven. One original bulk operation costs that sequence selection, two fresh maintenance checks and three bulk statements, or six. Caching maintenance or binding authority would change the safety behavior and is not the remedy.

Display publication groups only independent rows from the same owner. Message display state is still read after header publication. Part summary and display state publish together after the original search dirty-row call and canonical revision read. The original writer receives every key and retains current-Store admission, mutation guards and the outer COMMIT check. [The shared synchronization decision](../decisions/implemented/architecture/2026-11-09-organization-shared-sync-ledger.md) records the durable delivery ownership.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/sync-native-binding-work.test.ts` exercises actual native pair validation, partial creation, Scope/parent consistency, same-transaction changes and foreign Stores.
- [x] Machine check: `packages/harness/test/session/history-display-write-work.test.ts` forwards actual SQL and verifies original canonical bytes, projection order/count/generation, search dirty references and transaction/COMMIT rollback before work budgets.
- [x] Machine check: `packages/harness/test/storage/event-sink-capture-work.test.ts` passes with the derived six-dispatch budget, complete guarded key coverage, original receipt sequencing and exact failure/rollback behavior. The combined native producer work control passes with 1352 metadata reads and unchanged transaction/scan counts; keep the original `event-sinks.test.ts` neighbors.
- [ ] Machine check: the complete unchanged 10000-message capacity workload must meet its original producer and drain budgets before claiming capacity closure.

## Lessons

Count real dispatches through the original owner before optimizing or setting a budget. Treat control reads as required work, combine only independent row publication, and keep workload timing acceptance separate from a local work-count improvement.
