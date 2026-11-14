# Native message ordering repeated full-history work

## Executive summary

The complete capacity fixture exceeded its native append window before sharing began. Each Message write rescanned the complete ordering index inside its existing transaction and captured another complete cache value for publication after commit. Reusing verified order within the actual transaction removes those repeated scans without changing canonical writes or durable facts.

## Summary

The unchanged ten-client, three-Runtime, hundred-Session fixture produced 10,000 native messages in 247.5 seconds, exceeding its 240-second append window. Its 600-second overall budget, producer batches and workload remain unchanged. This failed attempt does not establish replay acceptance or a general memory bound.

## Timeline

Source tracing found that every order loader runs in a write transaction and therefore bypassed the global cache. A small regression wrote 32 real Messages and Parts in two transactions: the original owner performed 32 complete marker scans instead of two. The corrected owner retains all 64 durable commit facts and exposes the complete original history.

An additional public-write regression found a defect in the initial transaction cache: two overlapping writes could publish an earlier order after another mutation. All four canonical headers existed, but the same-transaction stream omitted one. The original implementation passed the same prepared fixture. Disabling memoization for the contended owner preserves the original scan and repair behavior; the final five focused cases pass. The earlier missing historical preparation and static patch errors are not behavioral evidence.

## Root cause

The cache lifetime did not match its readers. `writeInfo`, `removeInfo` and the snapshot repair path all enter the original write transaction, while the global cache was populated only after commit. Repeated full marker reads, sorting, array copying and deferred whole-cache captures amplified native work. Bounded synchronization frames did not prevent that local cost.

Mutation invalidation alone cannot prove that a later cache publication describes the current index when operations overlap. Cache admission must account for the complete public order operation, not only the instant of a marker write.

## Guardrails

The owner retains order only within its original live Store transaction, using exact Scope/Session tuples. Its first load still validates actual native state and markers. The existing mutation guard invalidates affected memo entries for typed writes and tree changes. Overlapping order operations disable reuse and publication for that owner through transaction completion. Other owners retain their independent memo. No global cache, deferred order publisher, lock, persisted generation or new authority is introduced. Metadata remains proportional to retained history. A later work-count regression also measures marker-array copies, filter visits, comparator inputs and ID extraction during the actual public writer. Sequential appends update the original transaction memo incrementally; reordering and removal still shift affected entries. These local work counts do not establish that a later Linux capacity attempt meets its unchanged time budget.

- [x] Machine check: `packages/harness/test/session/message-order-write-work.test.ts` verifies two scans for two native transaction batches, all Message/Part facts, same-count raw changes, original index removal, rollback, Store/Scope isolation and legal delimiter-bearing identities.
- [x] Machine check: `packages/harness/test/session/message-order-concurrent-write.test.ts` verifies complete native headers and history after overlapping and sequential public writes in the same transaction.
- [x] Machine check: native message read-error, stream-work, page, streaming-persistence, portable-index and turn-history suites preserve their original behavior.
- [x] Machine check: `packages/organization-runtime/test/capacity-sync.test.ts` passed the original complete workload after both native and downstream corrections; [shared-export acceptance](0196-shared-export-replayed-unchanged-history-through-writers.md) records the complete sample.

## Lessons

Measure canonical work as well as elapsed time. Match derived cache lifetime to the actual transaction, retain native mutation invalidation and test overlap before trusting a newly reachable cache. Small regressions explain the correction; they do not replace the complete capacity receipt.
