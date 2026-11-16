# Compaction coverage preparation opened one writer per header

## Executive summary

The first model-history read prepared compaction coverage through one write transaction per historical header, including unchanged ordinary messages. Bounded body reads therefore still paid for thousands of unnecessary native write admissions before serving history. Migration preparation needs an independent metadata-work bound.

## Summary

An instrumented 5000-message CI case reached its framework guard after spending 56.583 seconds in model-header preparation. Source tracing found the registered coverage migration's per-header writer. A real 257-header regression measured 257 write transactions against a maximum of three bounded windows. This identifies the unnecessary work; it does not attribute all CI wall time to that migration.

## Timeline

- The original history case failed before selected-body and rollout assertions completed.
- The owning migration was traced from `SessionHistory.modelMessageInfos` through central Session preparation.
- A new work-bound regression failed against 257 original writers; a concurrent-current-value control passed.
- Fresh transactional batches passed both controls and the original central migration/import/restart cases. The unchanged 5000-message workload completed all original assertions with coverage under its original 60-second guard.

## Root cause

Every enumerated header entered a write transaction and a fresh point read before the pure upgrader determined whether it needed a change. Ordinary current headers incurred the same admission and worker round trips as legacy summaries. Bounding selected body hydration did not bound preparation of those reads.

## Guardrails

- [x] Machine check: `packages/harness/test/session/compaction-migration.test.ts` — bounded real write windows, sparse legacy changes, unchanged current revisions, concurrent writer admission, central migration receipts and restart.
- [x] Machine check: `packages/harness/test/session/history-work-bounds.test.ts` — original 64, 512, 2478 and 5000 historical messages, finite bodies, continuation and rollout assertions under the unchanged guard.
- The [decision](../decisions/implemented/bug-fix/2026-11-15-batch-compaction-coverage-owner-preparation.md) retains fresh reads inside each original writer, rollback and existing migration identity.

## Lessons

Trace preparation before attributing a slow read to its visible query. Reducing native admissions must preserve freshness at the write boundary; previously enumerated values cannot replace current canonical records.
