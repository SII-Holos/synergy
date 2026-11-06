# Session observation hydrated unrequested history

## Executive summary

Several independent preparation and observation paths loaded complete historical bodies for decisions that needed headers, a finite window or a short preview. Opening Context details could also retain an unrequested complete execution aggregate. The correction assigns selection and exact preview work to History owners and propagates explicit consumer demand through the existing view transport.

## Summary

Long conversations amplified rollout bookkeeping, interrupted-tool repair, finite history reads and last-exchange refreshes. Preview hydration occupied the storage writer. Execution summaries repeated body decoding, while root Context readers and legacy consumers shared an undifferentiated loading path. Queue timing included preparation before actual agent admission.

## Timeline

On 2026-10-23, production-path tracing identified each body-dependent operation and the frontend subscription that retained complete summary work. Behavioral work bounds and concurrency barriers were added before replacing the reads. A consistent private installed-data copy was isolated from its original project bindings for comparative acceptance. Clone-backed SQLite samples that failed at WAL commit were retained separately; ordinary physical copies were used to remove that fixture variable from the comparison.

## Root cause

Convenient full-history helpers obscured the distinction between selection metadata and requested content. A redundant initial-history fingerprint made rollout admission proportional to all prior bodies. Last-exchange preparation inherited the publication transaction. Display summaries did not provide independently versioned execution facts, and frontend retention did not distinguish root Context from complete summary and trajectory consumers. Existing result-shape assertions did not constrain physical work or stale publication.

Delayed metadata notifications could replace newer Context attribution. Terminal repair could likewise publish an older assistant header after that assistant completed. Both cases required canonical source validation, in addition to preserving the execution lease.

Integration also exposed a mismatch between derived and persisted roots: historical assistants without an explicit `rootID` were selected correctly, but the write guard treated the absent persisted field as a different owner and skipped repair. Regression fixtures now cover both explicit and inferred roots; explicit ownership changes remain fenced.

Display refresh also replaced cached records without preserving extensions written by a control migration. Refresh now carries those fields into the canonical replacement; bounded backfill retains them only for matching content versions. The direct HTTP and manifest migration tests verify preservation and transaction rollback.

## Guardrails

[History work bounds](../../packages/harness/test/session/history-work-bounds.test.ts) cover multiple history sizes. [Execution facts](../../packages/harness/test/session/execution-facts.test.ts) cover demand-time preparation, cancellation cursors and replacement/deletion fences. [Stop and abandon tests](../../packages/harness/test/session/pause-abort.test.ts) preserve completed assistants and later input. [Context tests](../../packages/workbench/test/execution/context.test.ts), [projection tests](../../packages/workbench/test/execution/projection.test.ts) and [Web summary tests](../../apps/web/test/context/execution-summary.test.ts) cover shared preparation, independent demand, immutable recovery checkpoints and retention of the last complete summary during preparation or failure. The [implemented decision](../decisions/implemented/bug-fix/2026-10-23-bound-session-history-read-work.md) records ownership and tradeoffs.

## Lessons

Measure work at the production caller and include the UI's retained demand. Select before hydrating, prepare outside writers and validate every source that affects publication. Preserve exact accounting and preview semantics; cancellation, failure and unavailable coverage must remain explicit. Separate process-first reads, warm reads, fixture failures and real provider requests in acceptance evidence.
