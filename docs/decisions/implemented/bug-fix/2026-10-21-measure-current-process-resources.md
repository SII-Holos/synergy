# Decision Record: Measure current process resources without clipping or double counting

Status: implemented

## Problem

Process CPU time divided by elapsed wall-clock time measures CPU core equivalents, not a fraction of all host CPUs. Capping the result at one hides concurrent CPU consumption, while treating a ratio greater than one as an already-converted percentage misstates the displayed value. Selecting current server resources from the first 50,000 mixed-role samples can also report an old frame and incomplete window statistics. Diagnostics can mistake a trailing tool sample for the server. Adding runtime heap and external gauges assumes disjoint allocation accounting that Bun does not guarantee.

## Decision

The [resource sampler](../../../../packages/harness/src/observability/resources.ts) retains the existing CPU unit without its upper clamp: one means one fully used CPU core. Resource API schema descriptions state that values may exceed one. The [chart conversion](../../../../apps/web/src/components/performance/chart-model.ts) always multiplies ratios by 100, so 2.5 core equivalents displays as 250% without normalization by logical CPU count.

The [resource store](../../../../packages/harness/src/observability/store.ts) accepts optional role and exclusive upper-time filters without changing the default ascending detail order. The [dashboard](../../../../packages/workbench/src/performance/dashboard.ts) reads the first and latest server rows directly and obtains RSS peak and nearest-rank event-loop p95 from the complete server window through SQL. The role/time predicates use the existing resource index; no persisted fields or migrations are added. Child counts, measured counts and RSS sums cover the complete latest server frame, independently of the bounded detail read and Top-5 display. Scope-filtered dashboards retain process-wide resource coverage.

The [diagnostic summary](../../../../packages/harness/src/observability/diagnostics.ts) selects server first/latest evidence separately from mixed-role details and computes server pressure only from server samples. Bounded details retain both roles and include the selected server evidence even when mixed rows consume the detail limit.

The [Control Plane recovery record](../../../../packages/harness/src/session/memory-pressure.ts) reports process RSS before/after and their nonnegative observed decrease, matching the owner's current-byte unit. Heap, external and ArrayBuffer gauges remain separate. An immediate sample after requesting asynchronous GC is an observation, not proof of final reclamation or a measurement of the JavaScript live set. Asynchronous collection logs a request rather than completion. GC thresholds, cooldowns, stream safety, concurrency and sampling intervals remain unchanged.

## Alternatives considered

**Normalize CPU by logical core count or preserve the clamp.** Both change or hide the existing one-core unit and can obscure a saturated main thread.

**Filter or aggregate after a larger mixed-row limit.** A different limit still permits stale current values and incomplete peaks or percentiles. Window aggregates must not depend on detail budgets.

**Change every resource query to descending order.** Existing callers rely on ascending history. Role and time selection remain explicit options instead.

**Sum heap and external memory or infer live heap by subtracting external memory.** Neither operation establishes disjoint Bun allocation accounting. RSS gives the recovery and owner rows one consistent process-level unit without inventing a JavaScript live-set estimate.

**Force synchronous GC or introduce adaptive retry/backoff to make recovery measurements settle.** That changes collection policy without evidence for this correctness fix. Immediate observations retain their timing limitation instead.

## Consequences

Resource values remain comparable in their declared units, complete-window summaries do not inherit detail truncation, and child aggregates stay attached to the selected server frame. CPU percentages can exceed 100%. A process can release managed allocations without reducing RSS immediately; the recovery record deliberately reports the observed RSS decrease rather than an allocation-release claim. Child detail reads retain the existing 50,000-row budget and Top-5 presentation; they do not limit aggregate counts or RSS.

The existing [resource test](../../../../packages/harness/test/observability/resources.test.ts) uses deterministic CPU and clock values, and the [chart test](../../../../apps/web/test/components/performance/PerformanceDashboard.test.ts) verifies 2.5 becomes 250%. One [dashboard regression](../../../../packages/workbench/test/performance/store.test.ts) bulk-inserts 50,003 server frames plus mixed tool rows into real SQLite, including out-of-window rows and incomplete child measurements. The existing [diagnostics](../../../../packages/harness/test/observability/diagnostics.test.ts) and [memory-pressure](../../../../packages/harness/test/session/memory-pressure.test.ts) cases cover role separation and overlapping component gauges without duplicating the retained cooldown and stream-safety cases. These tests establish resource correctness, not a throughput improvement or final asynchronous GC reclamation.
