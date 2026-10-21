# Decision Record: Bound concurrent-session read amplification

Status: implemented

## Problem

Independent Session output can amplify unrelated frontend file refreshes, execution-detail reconstruction and diagnostics writes. Releasing an in-flight file request during invalidation permits overlapping reads. Coalescing Rollout records by identity discards intermediate revisions, and waiting for global event silence prevents bounded completion. Hidden cache updates can also force full descendant history reads.

## Decision

A file-domain registry shared by retained Session providers keeps one in-flight status request and a dirty bit per Workspace generation, admits automatic starts at 500 ms intervals, and uses existing view activity leases. Hidden consumers retain data and conflict evidence while deferring automatic reads. Shared transport cancellation semantics remain unchanged.

Execution read models buffer changes by retained root and Session ownership. Each load consumes one finite cut, retains consecutive Rollout revisions, repairs genuine gaps only for their owner and loads newly added branches independently. Context history and snapshots use root-only Rollout, Usage and canonical message headers. Shared loads count consumers, propagate cancellation cooperatively and yield between larger processing batches. A new reader after cancellation starts a fresh load. Node, owner, tool and message-step indices avoid repeated history scans. Typed query errors distinguish bad input from internal computation failures.

Message-derived execution records map both pending and generating tool arguments to the existing unknown execution state until execution starts. Passing the streaming input state through to the execution enum rejected valid trajectory reads; typed error separation exposed this internal validation failure during the real execution fixture.

Already mounted native panels retain their saved resource through the short gap between capability revalidation and built-in registration restoration. They stay inactive while registration is absent, and confirmed capability loss or tab closure still disposes them.

Queue-depth telemetry records last and peak gauges per lane in one-second windows. Explicitly expected missing reads are normal missing outcomes. Session message-order initialization and Agenda activity history mark absent derived indexes as expected; only `Storage.NotFoundError` permits initialization or an empty result, while storage availability and integrity failures propagate. Resource timing phases share existing duration rows. Pure Cortex progress publishes once per second, lifecycle changes remain immediate, and task updates reconcile object identities.

## Alternatives considered

**Replace the message synchronization or rendering architecture.** Existing projections, replay, pagination and retained view state already protect streaming and navigation continuity. The measured duplication can be removed within resource owners without changing these mechanisms.

**Increase cache or execution limits.** Larger budgets hide duplicate work and increase memory exposure. Existing cache, worker and memory-pressure bounds remain in force.

**Wait for all events or rebuild every descendant on invalidation.** Both make one request depend on unrelated producers and history size. Owner-local buffering and repair preserve canonical evidence with bounded completion.

**Emit a metric for every queue transition or timing phase.** This adds diagnostic load proportional to traffic. Windowed gauges and optional fields on existing rows retain peaks and phase evidence at bounded write volume.

## Consequences

Background presentation can lag until activation, and pure task progress has up to one second of publication latency. Lifecycle changes and the active conversation’s text stream remain immediate. A bounded event buffer may fall back to owner repair under extreme pressure. No persisted-state migration, response-shape replacement or concurrency-limit increase is required. Deterministic tests constrain work counts and ownership; fixed-device fixtures report timing and sustainable capacity separately from synthetic event throughput. See [frontend synchronization](../../../architecture/frontend-data-sync.md), [file resources](../../../architecture/workspace-and-files.md) and the [performance fixture](../../../../apps/web/test/performance/README.md).
