# Decision Record: Snapshot lease admission and cleanup lock budgets

Status: implemented

## Problem

Snapshot admission exposes a caller-supplied timeout with a 15-second default, but the metadata update gate used an independent one-second timeout. A live gate held beyond one second could therefore reject a lease before its admission budget expired, exposing a generic file-lock error instead of snapshot contention. The same short wait during disposal could leave an owner token registered after its operation ended. Process-identity fencing correctly protects such a token while its process remains alive, so release must tolerate transient contention rather than depend on stale-owner reclamation.

## Decision

`SnapshotLease.acquire` uses one deadline across Home and Scope admission. Every metadata-gate attempt receives the remaining budget and the caller's cancellation signal. Admission checks cancellation and deadline again after reading and validating owners, before registering a new owner. Exhausted metadata-gate waits become `SnapshotLease.BusyError`; an error that is the caller signal's cancellation reason is preserved unchanged, including a forwarded `FileLockTimeoutError`. Malformed state and other storage failures remain visible.

The shared `withFileLock` utility accepts an optional abort signal and exposes `FileLockTimeoutError`, preserving the lock key and existing default or custom message. Cancellation prevents entering protected work, including cancellation observed immediately after acquisition, and lock release remains protected by `finally`. Retry waits are interruptible and bounded by the remaining acquisition timeout. Existing callers without a signal retain their behavior and process-identity stale-owner checks.

Lease cleanup deliberately ignores the admission signal and expired deadline. It uses the file-lock utility's independent 60-second default wait so both normal disposal and failed exclusive admission can remove their registered tokens under transient contention. It still reports permanent contention or I/O failure; it neither removes another live owner nor treats cleanup failure as success.

The [shared snapshot storage decision](../architecture/2026-09-07-shared-file-snapshot-storage.md) remains authoritative for Home copy exclusion, Scope reader/pruner fencing, session index isolation, and retained roots. No persisted representation or migration changes.

## Alternatives considered

**Increase the one-second constant only.** A larger unrelated constant still bypasses caller-specific deadlines, delays cancellation, and conflates admission with cleanup. Threading the remaining budget expresses the existing timeout API instead.

**Use the admission signal and deadline for release.** Once either expires, cleanup could fail immediately with a still-registered live owner. Cleanup needs an independent opportunity to remove the caller's token.

**Suppress snapshot errors or delete contended locks.** Fail-open snapshots weaken restore and maintenance integrity. Age-based reclamation can displace valid work; timeout classification must not hide corrupt metadata or storage errors.

## Consequences

Transient metadata contention can use the intended admission budget rather than aborting at one second. Home and Scope waits do not each receive a fresh budget. Cancellation preserves its original reason, although necessary cleanup can delay its delivery; the admission timeout bounds admission rather than the total operation plus cleanup.

Real-file regressions hold each metadata gate beyond the former one-second limit, exhaust the shared budget, cancel waiting admission, and verify subsequent exclusive acquisition after disposal. Utility tests preserve timeout messages, cancellation, stale-owner fencing, and Windows delete-pending handling. These reproduce the premature timeout without asserting which process held a production gate or why that hold lasted longer than one second.
