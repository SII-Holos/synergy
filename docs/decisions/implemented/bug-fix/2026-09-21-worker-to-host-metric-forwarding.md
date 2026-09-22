# Decision Record: Forward Agent worker metrics through the owning turn

Status: implemented

## Problem

Provider fetch metrics are emitted inside Agent workers, where local observability storage is disabled. Enabling that storage would violate the Control Plane's ownership of canonical telemetry. Forwarding rows without a turn identity also loses the session, message, trace and rollout call needed to distinguish concurrent requests and reused workers.

## Decision

Agent workers forward metrics over the existing versioned turn IPC channel. The host records them through the normal sampling, redaction and storage pipeline.

`ObservabilityMetrics.withForwarder()` installs a Runtime-owned asynchronous context for one turn. The runner creates the queue when the turn starts, closes and drains it after stream disposal, and sends terminal frames afterward. An asynchronous callback from a completed turn retains that closed queue and cannot emit into its successor. Worker-local storage remains disabled.

Each `metrics` frame carries its `requestId` and at most 64 validated rows. A queue holds at most four frames and flushes on the next microtask. Names, correlation fields and scalar labels have protocol-owned bounds, and every frame passes the existing IPC byte limit. Invalid rows, queue overflow and failed sends increment a turn-local drop count without failing inference. Protocol version 11 requires both peers to understand turn-owned metric frames and the current Runtime bootstrap.

The host validates request ownership before recording metrics. It captures the owning Runtime and observability context when admitting the task, and supplies the canonical Scope, session, user message, rollout call and worker process identity. A row cannot replace those identities. The rollout call comes from `RolloutContext`, independently of an ambient tool call. Recently released requests use the existing late-frame drop path; metrics from an unknown request remain a protocol violation.

## Alternatives considered

**Enable worker-local observability storage.** Rejected because it introduces canonical writes and an additional telemetry worker into the inference process.

**Use one process-global forwarder and accept metrics outside turn ownership.** Rejected because Runtime disposal, concurrent asynchronous callbacks and worker reuse can attribute a row to an unrelated task. Runtime-owned context plus the request ID permits the host to reject stale ownership.

**Send one frame per row or acknowledge every metric.** Rejected because telemetry would add IPC traffic or inference backpressure. Bounded coalescing preserves the existing best-effort metric semantics; rollout transport acknowledgements continue to own durable evidence.

**Reconstruct identity from the worker's ambient context or logs.** Rejected because the worker does not own host tracing or rollout state, and log text is not a typed metric transport.

## Consequences

The [provider watchdog metrics](2026-09-21-provider-stream-watchdog-and-stage-metrics.md) are queryable with their actual task identity. Real subprocess tests verify database rows across sessions, models, timeouts, cancellation and worker reuse. Runtime tests verify forwarding isolation and disposal, while protocol tests cover batching and stale frames.

Metrics remain best-effort. An oversized frame or saturated queue loses telemetry instead of blocking inference, and the drop count is local rather than a durable delivery guarantee. Host and worker must come from a compatible build. Metric names and labels must fit the explicit row schema.
