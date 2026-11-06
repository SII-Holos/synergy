# Decision Record: Refresh reconciled execution endpoints

Status: implemented

## Problem

An allocation can keep the same container, start time and generation while its published transport endpoint changes after a network disconnect. Retaining an Executor connection by allocation identity alone prevents pending operations from reaching the recovered host.

## Decision

The execution connection cache includes the Environment's monotonic update timestamp. Reconciliation or another committed Environment update invalidates the earlier transport connection while preserving execution IDs, digests and allocation fencing. The provider resolves the current endpoint and verifies the same physical incarnation before returning a replacement connection. Recovery queries the existing execution; it never resubmits a command.

A deterministic regression changes the endpoint after a lost execution response and requires reconciliation, saving and release with one side effect. Local remote-loss acceptance also retains a query whose submission was dropped before transport delivery. Once connectivity returns, explicit cancellation establishes a terminal receipt with no effects before its durable use is released.

## Alternatives considered

**Remove all connection caching.** Resolving the provider for every output or status poll performs repeated endpoint discovery while the Environment is unchanged. Its existing monotonic update timestamp provides an invalidation identity without another persisted field.

**Replace the allocation after a network fault.** The original process and unsaved files can still exist. Replacing compute would discard the distinction between transport loss and confirmed physical loss and could repeat work.

## Consequences

Environment updates can refresh a transport connection even when the allocation generation is unchanged. Native providers continue to own and reuse their physical Executor. Missing execution receipts remain unknown until an explicit cancellation or another verified terminal receipt provides a safe release path.
