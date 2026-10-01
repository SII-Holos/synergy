# Decision Record: Preserve live Environment provider requests during maintenance

Status: implemented

## Problem

An Environment provider can publish an allocation before its allocate promise resolves, or remove an allocation before its deallocate promise resolves. Periodic maintenance then observes that physical effect and changes the catalog while the original request still owns the transition. The original request subsequently fails its state guard with `EnvironmentStale`. The defect reproduces with a synthetic provider in an isolated Harness Runtime on SQLite and PostgreSQL; no application adapter or execution host is required. See [issue #1514](https://github.com/SII-Holos/synergy/issues/1514).

## Decision

The Runtime owns one in-flight provider request per Environment. Allocation, release and reconciliation claim that ownership before changing state or invoking the provider and release it in a finally block. Reconciliation leaves a live owned request to settle; overlapping explicit provider operations fail with `EnvironmentBusy`.

The existing durable allocation intent, request identity and generation checks remain authoritative. A failed or canceled request releases its in-memory ownership, allowing ordinary uncertain-state reconciliation. A new Runtime has no live requests and performs the existing restart recovery. Maintenance remains enabled and continues reclaiming idle allocations.

## Alternatives considered

- Increasing deadlines leaves the competing catalog transition unchanged.
- Disabling maintenance prevents idle reclamation and restart recovery.
- Removing the final state guard could accept a different allocation or generation.

## Consequences

An allocation or release can finish after its provider side effect becomes visible without maintenance stealing its transition. Runtime-local ownership is appropriate because the storage namespace already has one Runtime owner. The behavioral regression covers both operations on SQLite and PostgreSQL; the existing Environment lifecycle suite covers uncertain allocation recovery, restart admission cleanup, idle maintenance and lost Workspace views.
