# Native control lookups repeated SQL dispatches

## Executive summary

The original Linux native producer exceeded its 240-second deadline. A real callback window identified repeated maintenance and single-write metadata requests. Store-owned combinations reduce verified SQL work while retaining fresh controls. They do not establish the unique deadline cause or the complete workload's wall-time result.

## Summary

The original offset-1000-to-1100 callback and flush dispatched 19,817 requests: 19,176 writer and 641 reader requests. Same-owner background work is included; not every request is attributable to those 100 messages. The window contains 2,004 maintenance-point queries plus 2,004 orphan probes, and 700 parent-tombstone plus 700 target-row queries. These identify request families rather than exclusive CPU cost.

## Timeline

- Linux reached 8,000 messages before its original deadline. The 9,000-message report arrived after cleanup began; healthy heartbeats and one epoch do not explain the missing producer completion. The later close failure is separate cleanup evidence.
- Existing maintenance status produced a native-query RED: two statements against the one-statement budget. An unconditional combined prefix was separately rejected by a real SQLite prefix fault despite a present point. SQL CASE skips that work; the original direct prefix query still triggers the fault, and rollback removes the temporary view.
- Candidate review found false prefix absence for a preparing Session. Real Store controls reject both absent and present external-point cases through the new primitive's independent prefix admission. Existing `queryKeys` and `list` behavior is unchanged.
- Sixteen actual single Session writes reduced metadata SELECTs from 32 to 16 and transferred bodies from 528,499 bytes to zero. The original guard, error ordering and typed/raw interleavings remain covered.
- Combined SQLite owner and Store/compatibility/node neighbors passed 49 cases and 412 assertions; Harness types passed. Real PostgreSQL 17.11 owner and storage contracts passed 43 cases and 565 assertions with two explicit SQLite-only skips.
- The same original callback window then dispatched 17,113 requests. The 2,704-request difference is exactly the 2,004 maintenance and 700 single-write reads removed; every other measured request family, including 641 reader requests, remained equal. No thin-target reread was needed in this window. Its workload, transaction/scan counters and single callback were preserved. This is a work-count comparison, not complete capacity or elapsed-time acceptance.
- The original full capacity case passed at `1ab2f8d27` before the row-phase correction: 10,000 native writes in 100 transactions took 89.859 seconds; produced data reached 95.937 seconds, drained work 223.208 seconds and total work 305.624 seconds. The case passed 6,082 assertions in 306.804 seconds. All four owned process IDs were absent after cleanup. This is an actual local pre-correction result, not final-HEAD or Linux acceptance.
- A real native-metadata Promise barrier then exposed a separate direct-transaction phase regression: changing publication restriction without issuing SQL left the query serial unchanged, and the optimized write resolved where rejection was required. The exact old write/put path passed all 16 control assertions. A metadata-only plan with admission and target checks restored to the original put row phase also passed those 16 assertions. The complete Store file then passed 21 cases and 202 assertions; Harness types passed. No production nested-snapshot incident or capacity attribution follows from this control.
- CI's event-capture work check rejected five native dispatches because it required exactly six, although its canonical facts, receipts and rollback assertions passed. The local original test reproduced that mismatch. Its corrected positive-work budget permits at most five dispatches and retains every data and fresh-authority assertion; both complete cases passed 37 assertions. Fewer dispatches must not fail a performance upper bound.

## Root cause

The proven local defect is repeated independent Store work. Empty maintenance checks separately observe the point and derived prefix. Single writes separately select parent deletion and target identity/revision with unneeded bodies. A naive combination can add full retained-prefix work or reuse stale metadata across admission.

The [decision](../decisions/implemented/bug-fix/2026-11-15-combine-fresh-store-control-lookups.md) retains independent canonical identity, conditional prefix work, both selector admissions and the later write checks. A complete connection query serial forces a fresh target read after unexpected SQL activity. It does not observe a publication-mode change that performs no query. Moving that admission into an earlier helper advanced its original phase across an await; retaining a metadata-only plan keeps later admission, selector and target/collision checks inside the original `put` row phase. The controlled public-transaction regression does not establish a production nested-snapshot incident. These results do not identify IPC, SQLite scheduling, background work or host load as the sole capacity cause.

## Guardrails

- [x] Machine check: `packages/harness/test/storage/runtime-maintenance.test.ts` — native statement bound, actual prefix-fault control, missing nodes, malformed records, dual-selector publication and rollback.
- [x] Machine check: `packages/harness/test/storage/transactional-store.test.ts` — actual SELECT/body-byte bound, parent/error priority, original guards, held typed/raw interleavings and real metadata-delivery restriction changes without SQL.
- [x] Machine check: `packages/harness/test/storage/{compat-admission,node-cleanup}.test.ts` — existing publication filtering, tombstones and traversal cleanup.
- [x] Machine check: `packages/harness/test/storage/event-sink-capture-work.test.ts` — positive native work bounded by five dispatches, exact facts and receipts, fresh authority and rollback.
- [x] Machine check: pre-row-phase-correction PostgreSQL owner/storage contracts in `packages/harness/test/storage/{transactional-store,runtime-maintenance,postgres-contract}.test.ts`.
- [x] Machine check: the original 10,000-message, 100-transaction capacity workload passed at `1ab2f8d27` under its unchanged 240-second producer and 600-second whole-case budgets.

Final delivery must repeat owner/backend and original full capacity acceptance at its final source revision; the earlier capacity and backend runs do not accept the row-phase correction.

## Lessons

Count engine requests and transferred bytes separately from wrapper calls and elapsed time. Avoid unused expensive branches and reject unconfirmed absence for every declared selector. Preserve awaited admission phases; reuse only current-operation metadata checked against the actual connection, never authority. Work-count improvement is not complete capacity acceptance.
