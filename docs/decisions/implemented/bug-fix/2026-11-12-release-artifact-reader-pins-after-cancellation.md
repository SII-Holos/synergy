# Decision Record: Release artifact reader pins after cancellation

Status: implemented

## Problem

An open binary reader pins its immutable artifact after the canonical reference is deleted. Closing that reader inside an aborted Storage queue scope submitted the pin decrement through the same queue. Admission rejected cleanup, leaving unreachable bytes protected from collection for the rest of the Runtime's lifetime.

## Decision

`Storage.readBinaryStream()` releases its in-memory pin synchronously in its original Runtime and Store scope. The decrement performs no storage I/O and requires no queue admission. Actual artifact reads and garbage collection retain their existing cancellation, serialization and ownership checks. Prepared binary disposal uses the same synchronous pin bookkeeping.

## Alternatives considered

**Admit cleanup through an uncancellable queue operation.** The decrement has no asynchronous work to serialize. Adding a cancellation exception to the queue would expand its public behavior for a local counter update.

**Keep the pin until Runtime closure.** Cancellation is an ordinary end of reader lifetime. Retaining unreachable artifacts after a completed reader would make repeated cancellations accumulate disk usage.

## Consequences

Reader cleanup succeeds even when its caller has cancelled queue admission. The selected pack remains protected until the reader closes; removing one reader's pin still preserves other prepared or active-reader pins. This changes no persisted format or artifact authorization.

## Verification

`test/storage/storage-binary-stream.test.ts` reads actual bytes, deletes their canonical reference, verifies collection preserves the active stream, aborts the original queue scope and closes the iterator. Collection then reclaims the artifact. Native pack and object artifact neighbors exercise the existing binary lifecycle. See [the incident](../../../postmortem/0112-cancelled-reader-retained-artifact-pin.md).
