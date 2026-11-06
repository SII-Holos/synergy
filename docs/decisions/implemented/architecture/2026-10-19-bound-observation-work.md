# Decision Record: Bound performance and execution observation work

Status: implemented

## Problem

Observation competed with productive work in three places: metric window functions ran on the Control Plane, unchanged execution polls entered the authoritative writer queue, and file status launched separate Git processes for repository detection, counts and names. Real-data isolated experiments reproduced request head-of-line blocking and repeated storage reads during idle native execution. The experiment method lives in [develop-synergy](../../../../.synergy/skill/develop-synergy/SKILL.md); private datasets and measurements are not repository artifacts.

## Decision

Observability owns a lazy readonly SQLite worker using the existing supervised SQLite client and bounded storage queue. Its connection uses an 8 MiB page cache and disables file mapping rather than inheriting the large authoritative-store cache. Aggregate statements are finalized after each request instead of occupying the general statement cache. Only metric aggregation APIs become asynchronous; their callers await results without changing HTTP schemas. Dashboard highlights select the consumed metric families before ranking, while counts, percentiles and timelines retain complete-window semantics. In-flight summaries coalesce across telemetry writes; completed summaries retain data-version invalidation. Worker failure propagates and permits later reader replacement; Runtime closure rejects queued work and drains the current operation before closing the process.

Execution observations validate identity before comparing state. Unchanged observations return without a write transaction; transitions retain the existing transactional authority checks. Native adapters expose optional bounded change notification after status/output persistence. The process facade reconciles on notifications and a 250 ms idle timeout, reads output only when its cursor advances, and preserves polling for transports without notifications. Notifications confer no execution or allocation authority. Physical completion, backpressure, cancellation and checkpoint acknowledgement keep their existing owners.

File status obtains raw change identity and line counts from one NUL-delimited Git diff and enumerates untracked paths with one additional command. Small untracked files are counted in batches of sixteen; existing file-size/count limits, cache invalidation and event-watermark semantics remain intact.

## Alternatives considered

**Increase all polling intervals.** This reduces idle reads but adds delay to streaming output and short commands. Native notifications reduce idle work while delivering changes promptly; remote transports retain their current polling contract.

**Keep aggregates synchronous and cache longer.** Cache misses still block unrelated requests, and a longer cache delays visibility of new telemetry. A separate read worker isolates misses while short caching remains useful.

**Serve stale file status during background refresh.** This complicates event-watermark reconciliation and changes freshness semantics. Reducing the native work preserves the current contract.

## Consequences

The first analytics query pays worker startup, and the additional SQLite process consumes memory and its own page cache. SQL CPU cost remains real; isolating it does not make queries free. Reader queues are bounded and failures stay visible. Native notifications are an optimization hint only, so authority changes still receive periodic validation. Remote executions receive unchanged-state and cursor optimizations without adopting a new wire protocol.

Behavioral verification covers asynchronous metric results and reader reopening, exact large-window totals, in-flight summary coalescing, unchanged execution writes, native idle read bounds, cancellation, paused output drainage, checkpoint fencing, renamed/tab-containing files and status-cache watermarks. Machine-specific latency is retained in private experiment reports rather than CI thresholds.
