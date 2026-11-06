# Decision Record: Await plugin Host operations before releasing resources

Status: implemented

## Problem

A Host Service can return the correct result while releasing its selected Environment resources before its asynchronous operation starts or settles. Returning a pending promise from an `await using` scope starts disposal immediately; a rejection during asynchronous disposal can also surface as an unhandled error before the caller receives it.

## Decision

The Host Service resource owner awaits `Tool.withWorkspace()` inside its `await using` scope. Selected resources remain owned through execution and operation cleanup, then dispose before the caller receives success or failure. The regression uses real Runtime, Scope and resource selection, observes disposal, and exercises successful and rejected execution at the sandbox process boundary.

## Alternatives considered

**Retry the failing CI test.** Rejected because the timing-sensitive rejection reveals an actual lifetime defect; retrying can hide early resource release without fixing it.

**Attach a rejection handler without awaiting execution.** Rejected because it can suppress the unhandled-error symptom while still allowing disposal before the operation finishes.

## Consequences

Host calls retain their existing capabilities, return values and error behavior while resource disposal follows operation completion. The owner waits for operation cleanup before returning, as required by the resource lifetime. The change adds no public API, migration or runtime protocol revision.
