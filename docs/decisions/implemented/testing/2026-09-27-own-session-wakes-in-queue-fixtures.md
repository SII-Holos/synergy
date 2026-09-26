# Decision Record: Own Session wakes in queue-observation fixtures

Status: implemented

## Problem

Response-card acceptance durably enqueues a user task and schedules a Session wake. Its callback-deduplication fixture inspects the queued item without providing an executable model. Letting that wake run starts work outside the assertion's scope and leaves Runtime teardown responsible for an unowned execution.

## Decision

The fixture acquires a real Session loop lease before accepting callbacks, preserving concurrent callback admission while keeping execution occupied. It drives the public wake before inspecting the queue, drains the queue in cleanup, and finishes the lease without requesting more work. A second public wake verifies that delayed scheduling cannot start a task after fixture cleanup.

## Alternatives considered

**Increase the cleanup timeout.** Additional time does not establish which test owns the queued execution or keep a wake from consuming the item before its assertions.

**Mock scheduling or the Session loop.** This would hide the production wake behavior that makes the fixture unsafe and introduce shared-module state into the package batch.

## Consequences

The existing callback, deduplication and payload assertions remain intact. Forcing the real wake without the lease fails with `ProviderModelUnavailableError` for the fixture model, proving that the original fixture could start an unintended Session execution. Both wake orderings pass with the lease and queue cleanup. The observed CI failure was a Runtime cleanup timeout after all seven test bodies passed; its logs do not identify the exact cleanup await that stalled. Validation covers the file and its original thirteen-file coverage batch on macOS and native Linux ARM64; the Linux x64 CI run remains the platform acceptance check.
