# Decision Record: Telemetry Row Volume Bounds

Status: implemented

## Problem

An idle write-amplification audit measured 22.37 MB/s and 7,733 write syscalls/s with no user interaction. Four of the contributors are instrumentation defects that produce rows far beyond the signal they carry.

Frontend token telemetry enqueued one metric per streaming delta for receive, apply, and paint — measured at 8.6 rows per 1,000 generated characters — and sent every row unsampled. `recordTokenReceive` runs once per delta and `recordTokenApply` enqueues an apply row plus a paint row per render frame, so a single provider response produces thousands of rows whose individual durations carry almost no information.

`PermissionNext.evaluate()` logged with `mirror: true`, which deliberately bypassed the DEBUG level gate in `util/log.ts`, making every permission evaluation an `obs_events` row: 85,655 of 87,242 `log.record` rows (98%). The comment justifying the opt-in described it as "deliberately bounded hot-path audit telemetry", which stopped being true once evaluation became a per-check hot path.

`AGGREGATED_COUNT_METRICS` exists to reduce row volume, but `aggregateKey` included per-turn identity (`sessionID`, `messageID`, `callID`, `processId`, `pid`) and per-request span identity (`correlationId`, `traceId`, `spanId`, `parentSpanId`, `rid`). A bucket therefore existed per concurrent turn, and aggregation collapsed almost nothing: 8.5 distinct rows/s for `storage.operation.count` alone.

The log writer called `write(msg)` then `flush()` on every line — 116 lines/s in a local install, one write syscall per line — and `cli/src/main.ts` returned `DEBUG` by default whenever `Installation.isLocal()`, so the local runtime recorded every debug line.

## Decision

`apps/web/src/components/performance/browser-metrics.ts` keeps `frontend.token.receive.count` exactly as it was: one row per delta, unsampled, because it is the volume measure of record. Apply and paint no longer emit per delta. `recordTokenDuration()` accumulates into a per-batch aggregate keyed by phase, context, part type, and message, and `flushBrowserMetrics()` drains those aggregates into one row each per flush batch, reporting the batch maximum and the summed `deltaChars` that produced it, sampled at the rate the operator sets in `observability.performance.samplingRate`, or at `0.1` while that key is unset. Metric names, the `ms` unit, and the `duration`/p95 catalog kind are unchanged, so existing catalog entries, queries, and dashboards keep working. `MAX_TOKEN_RECEIPTS` stays at 500.

The log mirror is now gated by `observability.logMirror` in the general config schema, defaulting to off. `Log.mirror()` mirrors warnings and errors unconditionally as before, and mirrors DEBUG/INFO only when the caller opted in with `mirror: true` **and** the switch is enabled, so the opt-in escape hatch stays functional for an operator who turns it on. `ObservabilityConfig` resolves the switch in the observability domain and exposes it as `ObservabilityConfig.logMirror()` rather than adding a field to the resolved performance `Info` schema, so the switch never widens the performance config API surface. The stale "bounded hot-path audit telemetry" comment is gone.

`ObservabilityMetrics.aggregateKey()` now keys the aggregated counter family on `name`, `unit`, `module`, `source`, `scopeID`, `tool`, `sampleRate`, and labels — dropping `sessionID`, `messageID`, `callID`, `correlationId`, `traceId`, `spanId`, `parentSpanId`, `rid`, `processId`, and `pid`. Metrics outside `AGGREGATED_COUNT_METRICS` are untouched and keep full per-session attribution, which is the point for them. Scope and tool stay in the key because the Performance read model filters and ranks by them (`storage.operation.count` ranks by its `operation` label; Scope is a query filter).

`util/log.ts` buffers lines and writes them in one batch on a 250 ms interval, flushing synchronously from a `process.once("exit", flush)` hook so an abrupt exit still lands buffered lines, and on write or flush error falling back to stderr so a broken writer cannot swallow the batch. `Log.flush()` remains synchronous and is still called by the server runtime's graceful shutdown. `cli/src/main.ts` no longer defaults to `DEBUG` when local; DEBUG is opt-in through `--log-level`, `LOG_LEVEL`, or `general.logLevel`, and `daemon-entry.ts` reads `LOG_LEVEL` with `INFO` as its fallback. Archive rotation (10 files / 200 MB) is unchanged.

## Alternatives considered

**Sample `frontend.token.receive.count` alongside apply and paint.** Rejected: the task of that metric is to count received deltas exactly. Sampling it removes the only exact volume measure while the per-delta row count is the volume itself, so it would trade the measurement for a fraction of the savings that the apply/paint collapse already delivers.

**Send an explicit `sampleRate` through the browser metric batch and let the server sample it.** Rejected: `PerfBrowserMetric` on the ingest wire has no `sampleRate` field and `ObservabilityBrowserMetrics.ingest()` does not forward one, so server-side sampling needs a schema plus ingest change, and a plain extra property would be stripped by the ingest's Zod object. The operator setting is already visible to the client as `observability.performance.samplingRate`, so client-side sampling at the aggregation point honors it with no wire-contract change.

**Report a percentile instead of the batch maximum for apply/paint.** There is no percentile helper in the client telemetry module, and the surrounding web code has none either; the batch maximum is reported and documented as such, which also preserves the "a stalled frame still surfaces" property that a p95 would flatten at low batch counts.

**Gate the permission mirror by log level instead of a config switch.** Rejected: the level gate is exactly what the opt-in bypassed, and tying per-check audit telemetry to a global DEBUG level would re-introduce 98% of `obs_events` for every operator who debugs anything. A dedicated default-off switch keeps the capability without the ambient cost.

**Remove `mirror: true` from `PermissionNext.evaluate()` and delete the opt-in path.** Rejected: the mirror capability is an intentional escape hatch and the Blueprint keeps it; only the default changes.

**Keep `sessionID`/`messageID`/`processId` in the aggregate key and aggregate only within a turn.** Rejected: that is the current behavior and it is what fails to collapse; concurrent turns are exactly the case that produces the measured 8.5 distinct rows/s.

**Drop the label payload from the aggregate key instead.** Rejected: labels are low-cardinality by construction (operation, kind, status) and are the dimensions the Performance panel ranks by; removing them would erase usable attribution while still leaving the identity fields to shard the key.

**Read the backend-resolved effective `samplingRate` instead of the raw key.** Rejected: `ObservabilityConfig` defaults `samplingRate` to `1`, so the resolved value is `1` for every operator who never set one. Honoring it would turn sampling off for the highest-volume metric family and silently undo the row reduction this record buys. The raw global config omits the key when unset, so the client reads the explicit value and keeps its own low default, which is exactly the distinction `browserTokenDurationSampleRate()` encodes.

## Consequences

Frontend token rows drop from one per delta per phase to at most one apply row and one paint row per flush batch per context, sampled at `observability.performance.samplingRate` (10% while unset), while `receive` remains an exact per-delta count. The aggregate apply/paint row reports a batch maximum rather than a per-delta distribution, so the histogram shape of individual apply/paint durations is no longer available from raw rows; the catalog continues to treat these as p95 durations over the reduced population. `PARAM` label sets are unchanged, so the harness-side enum allowlist and catalog entries need no change. A live rate change reaches the running collector through the same config-change effect that starts and stops it, so the new rate applies from the next flush batch.

Permission evaluation writes no `obs_events` row by default, removing 98% of `log.record` volume; the audit record remains available to an operator who sets `observability.logMirror: true`. `log.record` semantics are otherwise unchanged.

Aggregated counters now collapse across concurrent turns within a flush window: two records differing only in session, message, call, correlation, request, process, or span identity produce one row with the summed value. The merged row keeps the identity fields of its first sample rather than sharding on them, so querying the aggregated family by `sessionID` returns the rows that happened to be first in their window instead of every session's rows; the in-repo Performance timeline and dashboard callers do not filter the aggregated family by session (`loadTimeline` passes only the window and metric names, and the storage ranking uses the `operation` label). Metrics outside the aggregated family retain exact per-session attribution.

Log lines reach the file in 250 ms batches instead of per line, so a reader that tails the file during a run can observe a short lag; normal shutdown, `Log.flush()`, and the exit hook all land the pending batch. Local installs log at INFO instead of DEBUG, which removes per-line debug volume at the cost of debug detail unless it is explicitly requested.

Verification: `packages/harness/test/observability/store.test.ts` covers collapse across identity fields, retained separation by Scope and tool, retained per-session rows outside the aggregated family, and the mirror switch default plus opt-in; `packages/harness/test/util/log.test.ts` covers delivery of all buffered lines on shutdown and stderr fallback when the writer errors; `packages/harness/test/permission/telemetry.test.ts` covers no record at INFO, no record at DEBUG with the mirror off, and the bounded record with the mirror on; `apps/web/test/components/performance/browser-metrics.test.ts` covers the per-batch apply/paint collapse, that receive stays an exact count, that an unset `samplingRate` keeps the low default, and that an explicitly configured rate is honored when apply and paint drain.

## Related

- [Hot-Path Write Amplification](./2026-09-18-hot-path-write-amplification.md) covers the streaming-path and rollout-journal contributors from the same audit.
