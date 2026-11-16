# Cross-OS receipt polling lost the original Target rejection

## Executive summary

The actual cross-OS handoff passed prepared-peer assembly and strict HTTPS, then failed during Target preparation. Its foreground response was an unparsed 504 and subsequent receipt reads returned HTTP 200. The report discarded their decoded machine states and had no original Target rejection, preventing a concrete native diagnosis.

## Summary

The missing facts are an acceptance-fixture defect. The underlying native failure remains unassigned. A successful inspection request does not establish a matching signed preparation receipt, and a later Linux control error after host cleanup cannot independently explain the original failure.

## Timeline

- Both prepared native peers joined the same run and the original HTTPS bootstrap succeeded. The original source produced its frozen fact.
- Target preparation returned 504/HTML after approximately five seconds. Subsequent original inspections returned 200/JSON before the completion helper failed.
- The collected reports retained HTTP status and relative caller frames, but omitted the final decoded machine state and original preparation rejection. Actual Darwin owners completed cleanup.

## Root cause

The native Target removes its pending job when its original preparation Promise settles. Inspection describes current jobs and signed receipts; it does not retain that rejected Promise. The fixture recorded only the outer request failure and discarded fields from responses it had already decoded. Those observations could not distinguish an unfinished or failed native preparation from a terminal receipt mismatch.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/cross-os-control.test.ts` — original Promise identity, error and successful value survive passive observation; five rejections retain at most four safe records, copied snapshots cannot mutate retained facts and hostile observation cannot replace the native rejection.
- The actual peer observes only its enrolled Target callback through a factory restored immediately after startup. Original local failure reports retain the snapshot after cleanup, without a new request.
- The existing bounded request ring retains only decoded machine state, stage and fact count. Native signatures, bindings, full proofs, paths and messages are not included.
- Exact-head real CrossOS acceptance must still establish complete bidirectional native work and cleanup. These observations do not repair or assign the unknown native cause.
- The [original transport observation decision](../decisions/implemented/testing/2026-11-15-observe-original-transport-phases-in-acceptance-tests.md) owns the finite reporting rules.

## Lessons

Preserve the original callback outcome before later reconciliation can erase it. HTTP success and a completed native operation require separate evidence; diagnostics must not change either result.
