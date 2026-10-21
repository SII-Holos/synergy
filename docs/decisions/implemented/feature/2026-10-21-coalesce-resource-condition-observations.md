# Decision Record: Coalesce resource condition observations

Status: implemented

## Problem

Resource pressure is a condition, not an independent error on every sample. Publishing an issue at most once per minute does not reduce the cost of constructing, redacting, parsing, transferring and upserting every repeated observation. An alert that never receives an explicit recovery transition also remains open after the resource returns to normal. Coalescing cannot discard the observation count or substitute missing measurements for evidence of recovery.

## Decision

[`ObservabilityIssues.observeCondition`](../../../../packages/harness/src/observability/issues.ts) owns the condition lifecycle. Its identity combines Scope, a fixed resource-owner category and a stable condition code; Session, trace, request and sample identities never partition the aggregate. Owners submit `active`, `normal` or `unknown` observations with finite measured values, thresholds and units. The input has no arbitrary message or evidence payload. Only redacted descriptive metadata, numeric evidence and attribution identifiers remain in the runtime aggregate.

Entry and severity escalation publish immediately. A finite `normal` observation resolves only that owner and condition, publishes `issue.resolved`, and ends the episode. A subsequent `active` observation starts a distinct episode with a new issue ID and fresh first/peak evidence. Missing values, non-finite values, unavailable heap ratios, collection failures, unknown observations and stopping a resource sampler do not resolve an issue. Ordinary discrete `raise()` calls retain their existing semantics and live-publication coalescing.

Ongoing active observations update first/latest/peak evidence and an exact pending occurrence delta before repeated issue parsing, redaction or IPC. The existing writer flush hooks and 250 ms batch timer materialize one issue row per dirty episode per batch. Reads flush pending aggregates; the worker-mode synchronous detail reads retain their existing asynchronous visibility, and `Observability.flush()` additionally waits for the existing worker flush acknowledgement. Stop drains pending aggregates through the same writer lifecycle. Recovery is an ordered, typed `issue-status` batch row implemented by the store and worker, not a caller-owned SQLite update.

[`ObservabilityDbWrites.insertIssue`](../../../../packages/harness/src/observability/db-writes.ts) adds `excluded.occurrence_count` atomically while retaining the established latest-description and latest-attribution update. The existing issue columns and extensible evidence record hold condition metadata; no schema version, table or durable counter is added. A retained condition episode can resume after a clean Runtime reopen without losing its committed first/peak/count evidence. The versioned `20261021-observability-condition-episodes` upgrade suppresses only open default aggregates for the six replaced resource threshold codes. It preserves their original attribution, counts and evidence, explaining that owner and recovery history cannot be reconstructed; it does not invent recovery, rewrite custom fingerprints or alter already resolved episodes.

The existing bounded queues account for the number of observations carried by each row. Queue eviction and rolled-back batches count as known drops. Sent batches whose worker exits without confirmation count as `uncertain` observations, exposed by store statistics and `observabilityUncertainObservations` in diagnostics. The worker continues using cumulative row confirmations and the existing restart backoff. There is no replay, per-batch durable receipt or new retry mechanism.

## Alternatives considered

**Continue minute-long live-publication suppression alone.** This leaves all construction, redaction, IPC and SQLite work on the repeated-observation path and cannot express recovery.

**Add a second delayed condition writer.** A minute-long persistence timer would delay evidence and duplicate the existing batching, read-flush and shutdown machinery. Condition aggregation instead participates in the current writer flush.

**Merge arbitrary errors by their formatted message or retain raw payloads.** Unrelated errors can share wording, while raw messages and evidence can contain sensitive data and create unbounded identities. Only the explicit resource-condition path aggregates safe observations; discrete errors continue through `raise()`.

**Replay unconfirmed deltas after worker failure.** The current cumulative acknowledgement does not identify whether an individual batch committed before its acknowledgement was lost. Replaying a non-idempotent occurrence increment can double-count. Adding a durable receipt/counter platform is outside this feature; unresolved confirmation remains explicit instead.

## Consequences

The real Runtime/SQLite work-count regression compares 1,000 discrete raises with 1,000 active condition observations. Discrete raises perform 1,000 issue parses, 1,000 redactions and 1,000 issue writes. The condition path performs one entry parse plus one batch parse, two redactions and one issue write; the separate read-model parse is excluded from construction counts. The real subprocess regression verifies a single issue IPC row for those 1,000 observations and observes the existing timer committing the batch without a read-triggered flush. Interleaved Scopes and owners each retain one independent exact-count write.

Behavioral coverage lives in the existing [store tests](../../../../packages/harness/test/observability/store.test.ts), [resource tests](../../../../packages/harness/test/observability/resources.test.ts), [worker-mode store tests](../../../../packages/harness/test/observability/store-worker-mode.test.ts), [telemetry worker tests](../../../../packages/harness/test/observability/telemetry-worker.test.ts), [protocol tests](../../../../packages/harness/test/observability/telemetry-protocol.test.ts), [disabled tests](../../../../packages/harness/test/observability/disabled.test.ts) and [diagnostics tests](../../../../packages/harness/test/observability/diagnostics.test.ts). They retain discrete latest-attribution checks, exercise episode recovery/reentry and severity escalation, test Runtime reopen and stop, and distinguish weighted queue/transaction drops from uncertain worker loss. The former worker-loss assertion equating unconfirmed rows with definite loss is replaced, not retained as a false durability claim.

This is bounded, best-effort telemetry. Successfully committed SQLite batches retain their evidence, but host crash, queue overflow, transaction failure or worker failure can still lose pending observations; a lost worker acknowledgement can leave committed evidence classified as uncertain. Runtime loss counters themselves are not durable. No cross-crash exactly-once or lossless guarantee follows from a flush acknowledgement, and no automatic replay is introduced. The internal recovery event does not by itself extend the Workbench SSE event vocabulary.
