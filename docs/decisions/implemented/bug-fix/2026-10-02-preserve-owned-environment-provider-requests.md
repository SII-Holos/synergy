# Decision Record: Preserve live Environment provider requests during maintenance

Status: implemented

## Problem

A provider can expose a completed allocation or removal before its request resolves. Maintenance can then publish the catalog transition ahead of the original caller, causing that caller to fail its state check with `EnvironmentStale`. Inspection can also resume an allocation or repeat a deallocation while the first request is still running. This is the lifecycle race described in [issue #1514](https://github.com/SII-Holos/synergy/issues/1514).

## Decision

The Runtime owns one in-flight allocation, release or reconciliation per Environment. These operations claim ownership before changing state or invoking the provider, retain it through final catalog publication, and release it in a `finally` block. Reconciliation skips an owned request; overlapping explicit provider operations fail with `EnvironmentBusy`.

The durable allocation intent, request identity and generation checks remain authoritative. Failed requests release in-memory ownership so ordinary reconciliation can inspect their outcome. A new Runtime has no live ownership and performs existing restart recovery. Maintenance remains enabled for other Environments and for idle reclamation.

## Alternatives considered

**Await the original request in maintenance.** Waiting couples the maintenance loop to provider latency and can delay recovery of unrelated resources. Skipping permits the next tick to inspect a failed request after it settles.

**Infer ownership from persisted state.** An `allocating` or `releasing` record can outlive its Runtime. Treating that state as live ownership would prevent crash recovery; the storage namespace already admits one writing Runtime.

**Disable maintenance or remove the final state check.** Disabling maintenance loses reclamation and recovery. Removing the check could accept a different allocation or generation.

## Consequences

Provider effects can become visible before the caller completes without maintenance stealing its catalog transition. An unsettled provider request defers reconciliation of its own Environment until that request settles; no new deadline or durable owner field is introduced.

Behavioral tests hold provider responses at explicit barriers on SQLite and PostgreSQL, cover ready, pending and absent inspection states, reject duplicate release, recover failed responses, and run equal Environment identities in independent Runtimes. Existing lifecycle tests retain restart recovery and periodic idle reclamation coverage.
