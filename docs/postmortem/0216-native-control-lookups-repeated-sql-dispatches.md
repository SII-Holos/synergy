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

## Root cause

The proven local defect is repeated independent Store work. Empty maintenance checks separately observe the point and derived prefix. Single writes separately select parent deletion and target identity/revision with unneeded bodies. A naive combination can add full retained-prefix work or reuse stale metadata across admission.

The [decision](../decisions/implemented/bug-fix/2026-11-15-combine-fresh-store-control-lookups.md) retains independent canonical identity, conditional prefix work, both selector admissions and the later write checks. A complete connection query serial forces a fresh target read after unexpected activity. These results do not identify IPC, SQLite scheduling, background work or host load as the sole capacity cause.

## Guardrails

- [x] Machine check: `packages/harness/test/storage/runtime-maintenance.test.ts` — native statement bound, actual prefix-fault control, missing nodes, malformed records, dual-selector publication and rollback.
- [x] Machine check: `packages/harness/test/storage/transactional-store.test.ts` — actual SELECT/body-byte bound, parent/error priority, original guards and held typed/raw interleavings.
- [x] Machine check: `packages/harness/test/storage/{compat-admission,node-cleanup}.test.ts` — existing publication filtering, tombstones and traversal cleanup.
- [x] Machine check: real PostgreSQL owner/storage contracts in `packages/harness/test/storage/{transactional-store,runtime-maintenance,postgres-contract}.test.ts`.
- [ ] Machine check: complete original 10,000-message, 100-transaction workload under unchanged 240-second producer and 600-second whole-case budgets.

## Lessons

Count engine requests and transferred bytes separately from wrapper calls and elapsed time. Avoid unused expensive branches and reject unconfirmed absence for every declared selector. Preserve awaited admission phases; reuse only current-operation metadata checked against the actual connection, never authority. Work-count improvement is not complete capacity acceptance.
