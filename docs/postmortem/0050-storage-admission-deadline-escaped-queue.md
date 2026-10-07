# A queue wait deadline escaped into running storage recovery

## Executive summary

Managed Desktop still failed after the Runtime readiness correction, but the backend now exited itself with a storage admission error. The artifact gate's 30-second queue wait cap had become an inherited deadline for the entire collection. Once elapsed, a later idle SQLite reader rejected admission. The correction separates local waiting limits from explicit caller deadlines across all storage queues.

## Evidence and sequence

The failing launch reached storage recovery and reported inspected artifacts before exiting with `Authoritative storage admission deadline exceeded (sqlite.reader)`. Completed migrations and index maintenance did not establish successful recovery. The earlier [readiness incident](0049-storage-recovery-startup-progress-gap.md) fixed premature Desktop supervision but did not validate a complete startup on the affected dataset.

An isolated copy of a database larger than 40 GiB, containing over ten million artifact references, completed a warm startup in about 23 seconds. That success did not reproduce the failure. Adding one controlled 31-second pause inside the real artifact scan caused the same admission error with the unchanged queue implementation. After correction, the same copied database and delayed scan reached Runtime readiness. This timing experiment establishes the deadline boundary; it does not claim that the injected delay measures production throughput. Early and exhausted SQL cursor pages use the existing namespace/pack index.

Unmodified managed Desktop startup from a fresh copy of that snapshot reached both Runtime and renderer readiness on Bun 1.3.14. A normal restart also reached both on the repository's Bun 1.4.2. The delayed managed run kept attachment progress visible beyond 30 seconds and then entered the application. Original source database fingerprints remained unchanged; credentials were excluded and the backend was fenced from writing or signaling the original environment. Existing session records remained byte-identical in the copy.

## Root cause

`StorageQueue.run()` computed the minimum of enqueue time plus 30 seconds and inherited/caller deadlines. It used that combined value both to expire waiters and as async context for the running callback. `collectArtifactGarbage()` holds `artifact.gate` across several SQL admissions and filesystem passes. Crossing the gate's original deadline made a later `sqlite.reader` admission fail before any query ran. This was not evidence of reader contention, a failed migration, or a health-check timeout.

Small fixtures finished within the cap. The previous progress tests delayed recovery entry points or advanced the Desktop observer's clock, without crossing a live storage gate's own monotonic deadline. They established presentation and supervisor behavior, not the success of every nested storage operation. Declaring the complete startup defect resolved exceeded that evidence.

## Guardrails

The [deadline decision](../decisions/implemented/bug-fix/2026-10-06-storage-admission-deadline-scope.md) gives local admission waiting and explicit request deadlines separate lifetimes. Regression tests fail on the previous implementation, preserve referenced and import-pinned artifact bytes, reject expired waiters, and retain cancellation and explicit request bounds. The persistence and development Skills require testing a running operation across its admission budget and distinguishing controlled-delay evidence from unmodified real-data acceptance.
