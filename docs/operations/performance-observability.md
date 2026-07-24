# Performance Observability

Synergy includes a first-class Performance settings panel for local runtime, frontend, network, and resource performance. Performance is the user-facing read model over Synergy's indexed observability store. Observability owns the canonical telemetry foundation: context propagation, redaction, events, metrics, spans, issues, resource samples, migrations, and diagnostics. Diagnostics is a support API and package capability backed by the same indexed data plus redacted logs and runtime inspection.

## What the Performance panel shows

Open the **Performance** workbench panel from the sidebar to inspect the default recent monitoring window. The panel summarizes:

- window-bounded health status, health score, exact open issue counts, and up to 20 recent issue details;
- HTTP request count, error rate, and p50/p95/p99 latency;
- session turn latency, inflight or stale operations, LLM calls, tool calls, and repeated tool-failure issues, including model calls to unknown tools, invalid tool arguments, tools hidden or blocked by session mode and permission rules, and executor failures;
- CPU, server RSS, JavaScript heap, external memory, ArrayBuffer memory, event-loop lag, and app-owned disk IO;
- whole-service memory from Linux cgroup v2 when available, otherwise the server plus registered child-process RSS sum with explicit partial coverage;
- registered tool child process count, measured RSS count, RSS total, and top child process memory contributors;
- session runtime counts, MessageCache footprint and eviction counters, active LLM turn/stream counts, and retained Cortex task counts, including retained prompt/output/error character totals;
- frontend session-switch timing, token receive/apply/paint timing, browser Web Vitals, ResourceTiming, UserTiming, long tasks, and long animation frames when the browser supports them;
- slow routes, sessions, tools, providers, storage operations, child processes, and trace drill-downs.

The Web panel loads a snapshot when it opens or when the selected time range changes. The snapshot remains stable until **Refresh** is selected; the panel does not poll, refresh after visibility changes, subscribe to live Performance events, or refetch charts as they enter the viewport.

Every record is stored with low-cardinality attribution such as source, module, Scope/session/request/tool/provider/process IDs, correlation IDs, trace IDs, span IDs, and safe labels. Sensitive prompt, response, header, credential, environment, raw body, and file-content data is redacted or omitted before it reaches public read models or diagnostics packages.

Permission evaluation emits no per-check log record at INFO or higher. DEBUG keeps a bounded diagnostic record containing only the permission name, requested pattern length, and merged ruleset count. Raw requested patterns and merged permission rules are intentionally omitted so repeated authorization checks do not expose command or path contents through observability.

Server resource samples are kept separate from registered tool child process samples. A server sample also persists cgroup v2 gauges and lifetime OOM counters when available, plus a service-memory reading whose source and completeness remain explicit. Linux cgroup v2 reports the complete cgroup charge; other hosts fall back to the server RSS plus measurable registered child RSS and report partial coverage. Child aggregates use the single latest snapshot frame rather than the Top-5 display list. Stale registered child processes whose pid no longer exists are settled into finished process history before new resource samples are stored. Each live process retains at most 200,000 output characters in bounded segments; full output and the 2,000-character tail are materialized only when a consumer reads them.

## AI analysis

Use **Analyze** in the Performance toolbar to snapshot the selected monitoring window and ask the hidden `performance-analyst` agent for a concise health verdict, evidence-backed findings, recommendations, and material data gaps. The panel displays queued and running state, supports explicit cancellation, renders the final Markdown result directly, and links to the durable analysis Session for inspection.

Analysis runs in one visible, tool-free, ordinary top-level Session with the `performance-analyst` agent override. The prompt receives only a bounded read model: raw trace, span, session, issue, correlation, process, and fingerprint identifiers are omitted; child processes receive anonymous labels; time-series points are reduced to aggregate trends; and inflight work is capped. Telemetry strings are treated as untrusted data. Starting an analysis requires an available Thinking model and does not grant the analyst filesystem, shell, network, or other tools.

## Local storage

Canonical telemetry is stored locally in SQLite with WAL mode:

```txt
~/.synergy/state/observability/observability.sqlite
```

The indexed store contains `obs_*` tables for metrics, spans, events, issues, resource samples, browser batches, and metadata. Runtime queries, diagnostics summaries, and diagnostics packages read this store instead of scanning trace files. Optional JSONL mirror files can be enabled for debugging exports, but they are not the runtime query source.

Startup migrations import the previous indexed performance store when it exists. Legacy schema detection stays inside the observability migration boundary, copied rows are redacted into the canonical `obs_*` tables in bounded batches, and the central migration runner records completion only after the upgrade succeeds. Runtime readers use only the canonical store.

Observability schema v5 adds nullable cgroup and service-memory columns to `obs_resource_samples`. The additive migration `20260722-observability-resource-cgroup-v5` is idempotent; existing rows remain readable with `NULL` for fields that were not sampled.

The configured SQLite limit applies to the combined database, WAL, and shared-memory footprint. Maintenance checkpoints WAL, incrementally reclaims free pages, and removes the globally oldest eligible historical rows in bounded batches. Running spans and open issues are protected from size eviction. If protected state or the minimum schema footprint prevents the configured limit from being reached, diagnostics expose the remaining excess instead of silently deleting live operational state. Full `VACUUM` is reserved for the one-time migration that enables incremental auto-vacuum on an existing database.

High-frequency count signals such as LLM stream output, child-process output, and storage-operation counts are aggregated by attribution key before SQLite flush. Stream chunk-gap and throughput signals are summarized once per stream and output kind rather than written for every chunk. LLM memory checkpoints run at lifecycle boundaries and at a five-second periodic interval rather than for every provider chunk. This keeps writer queue depth bounded without removing trace, Scope, session, message, provider, tool, or process attribution.

## Cross-platform session memory benchmark

Use the isolated session-memory harness to compare the same bounded fixtures on Linux, macOS, and Windows without contacting a model provider or modifying Synergy state:

```bash
bun run perf:memory --preset smoke
bun run perf:memory --preset standard
```

Each scenario runs in a fresh Bun child process and reports `baseline`, `peak`, and `afterGC` values for RSS, JavaScript heap, external memory, ArrayBuffers, and runtime footprint. Footprint is `null` when the active Bun build does not expose `Bun.unsafe.memoryFootprint()`. `history-projection` exercises Synergy's message-to-model projection with deterministic tool output. `tool-stream` exercises chunked `Uint8Array` decoding, JSON tool-input parsing, and release. Keep the preset, Bun version, and architecture identical when comparing platforms. The harness is a bounded regression baseline, not a concurrency or stress test.

Use the runtime harness for a complete server and Session lifecycle benchmark:

```bash
bun run perf:memory:runtime --preset smoke
bun run perf:memory:runtime --preset standard
bun run perf:memory:runtime:matrix --preset smoke
```

Every run creates a fresh temporary Synergy home, workspace, loopback server, and deterministic local mock provider. It does not copy user configuration, credentials, Sessions, state, logs, or caches, and it makes no external model request. Child processes inherit only an explicit allowlist of process-launch, temporary-directory, locale, and time-zone variables; provider credentials, proxy settings, runtime injection options, and ambient Synergy tuning are excluded.

The runtime harness exposes three scenarios:

- `--scenario trajectory` keeps the original one-primary trajectory with four parallel background subagents.
- `--scenario parallel` runs five primary Sessions concurrently in the same Synergy process. Each standard replica replays the real trajectory's 10-round heavy primary turn with its original 45 tool calls and byte sizes. Because the source turn ended at a step limit, the harness adds one fixed minimal terminal response so every standalone replica reaches a comparable completed state; that response is part of the workload contract and fingerprint. Historical `task` calls are mapped to the payload tool in this scenario so primary concurrency is measured independently from subagent fan-out. The Agent worker pool is fixed at five workers instead of using a machine-dependent CPU-derived default.
- `--scenario sequential` runs and deletes five copies of the same heavy primary turn in one Synergy process and records a memory checkpoint after each deletion.

`--scenario all` runs all three scenarios in separate temporary Synergy processes so one scenario cannot contaminate the next. It is the default matrix for cross-platform comparison. `trajectory` remains the default when no scenario is provided, preserving the original command and output behavior. The smoke preset uses two primary replicas, a two-worker concurrency ceiling, and the first lightweight completed exchange for both new scenarios, providing a fast harness validation rather than a load result. The trajectory and sequential standard scenarios use a four-worker ceiling.

The benchmark pins the complete elastic Agent worker lifecycle instead of treating `agentWorkers` as an eagerly resident pool size. Every profile uses `agentWorkerMinIdle: 0`, a 60-second idle retirement timeout, a 64-turn recycle limit, and deterministic post-GC baseline-recycle thresholds. The 5/30/120-second release samples therefore cover both warm-idle retention and post-retirement memory. These settings are present in the result and workload fingerprint; changing any of them creates a different workload contract.

The standard workload is derived from one anonymized completed Synergy trajectory rather than hand-picked turn counts. Its checked-in structural fixture contains one root Session, four parallel background subagents, 97 source messages, 220 tool calls, 576 stored parts, and about 2.6 MB of stored message data. Roles, ordering, parentage, relative timing, terminal status, tool type/status, and payload sizes come from the source trajectory. Prompts, outputs, paths, IDs, provider/model names, and all credentials are excluded and replaced with deterministic byte-preserving data.

The replay keeps `task`, `task_output`, Cortex completion notifications, Session inbox handling, persistence, and deletion on their native runtime paths. Historical tools that could read, write, or execute local data are mapped to a loopback-only payload tool that reproduces their call count, input/output byte size, and error status without replaying the original operation. Persisted history does not retain provider chunk boundaries, so the mock transport uses deterministic SSE framing and does not claim to reproduce the original network chunk cadence. `smoke` replays only the first completed source exchange to validate the harness. `standard` is the comparable cross-platform result.

Messages generated by the current runtime but absent from the source trajectory are reported separately. For example, the current dev build persists an empty assistant boundary when the root Agent reaches its step limit; it is validated as a runtime boundary artifact and is not counted as a source trajectory message.

A periodic sampler records server RSS, JavaScript heap, external memory, ArrayBuffers, child-process RSS, the complete server process-tree RSS, and available service-memory telemetry by phase. Process-tree discovery uses procfs on Linux, `ps` on macOS, and PowerShell process metadata on Windows. Resource fields are required; the benchmark fails instead of emitting a successful result with missing memory values. After all replay Sessions are deleted, it records the 5, 30, and 120 second release trajectory before stopping the temporary server and removing all temporary data.

Keep the runtime JSON separate from the process-level microbenchmark table. Compare process RSS, process-tree RSS, heap, external memory, and ArrayBuffers across platforms. Process-tree RSS is a sum and can count shared pages more than once; use it to attribute descendant growth, not as physical working set. Linux service-memory/cgroup values are additional evidence only because an ad hoc test process may share a cgroup with its benchmark parent rather than owning a production-style service cgroup.

### Cross-version comparison

Each runtime result records the source Git revision, dirty-worktree state, fixed execution settings, workload contract version, and workload fingerprint. The fingerprint is derived from workload semantics rather than implementation files: fixture identity, scenario, preset, replica count, aggregate messages/tools/bytes, the complete Agent worker lifecycle settings, timing, and adapter behavior. Internal refactors do not change it unless the benchmark load itself changes.

Run the same scenario and preset from clean baseline and candidate worktrees on the same machine and Bun version:

```bash
git -C /path/to/baseline checkout <baseline-revision>
git -C /path/to/candidate checkout <candidate-revision>

cd /path/to/baseline
bun install
bun run perf:memory:runtime --preset standard --scenario parallel > baseline.json

cd /path/to/candidate
bun install
bun run perf:memory:runtime --preset standard --scenario parallel > candidate.json
```

Only compare results whose workload contract version and workload fingerprint are identical. The stable JSON paths include workload-phase peaks, sequential deletion checkpoints, and 5/30/120-second absolute and idle-relative retained memory for server RSS, process-tree RSS, descendant RSS, heap, external memory, and ArrayBuffers. Candidate minus baseline is the memory-load delta: positive values are regressions and negative values are improvements.

For release decisions, use at least three runs per revision and compare medians rather than one favorable run. Keep the raw JSON artifacts with the tested revision. The harness remains valid across structural changes as long as the main LLM, Session, tool, and subagent interaction contract represented by the workload descriptor is unchanged.

## Runtime config

Performance settings extend the existing runtime observability domain in `120-runtime.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "performance": {
      "metricRetentionMs": 86400000,
      "traceRetentionMs": 86400000,
      "resourceSampleIntervalMs": 5000,
      "storage": {
        "sqliteEnabled": true,
        "jsonlMirrorEnabled": false,
        "maxSqliteBytes": 262144000,
        "walCheckpointIntervalMs": 60000,
      },
    },
  },
}
```

Use the generated SDK for non-streaming Performance API calls. The Performance SSE stream is `/global/performance/events` and emits refresh hints plus heartbeat events; clients should refetch summary after reconnect.

Performance config updates reconfigure resource sampling, retention, capacity maintenance, and WAL checkpoint timers in the running server. Changing `storage.sqliteEnabled` still requires a restart because it changes store ownership and lifecycle. Browser telemetry uses bounded keepalive batches during page unload so the final batch stays within browser transport limits.

Session turns establish the root observability context. LLM and concurrent tool spans inherit that trace and record explicit parent span IDs; tool heartbeat and stalled updates retain the Scope captured when each tool starts rather than reading ambient timer context.
Running spans left behind by an unclean shutdown are reconciled after the new runtime acquires the server process lock. Reconciliation ends each orphan at its persisted last activity time and marks it `interrupted`; graceful shutdown performs the same transition before resource storage stops. Inflight window filtering uses last activity rather than span start time.
On Bun, heap-used divided by heap-total is not treated as a pressure ratio because those values do not share a trustworthy accounting invariant. Heap byte gauges remain visible, while ratio-based pressure issues are suppressed and diagnostics report the unavailable ratio reason.

## Session memory pressure

Memory policy follows process ownership. The Control Plane can collect only its own Bun heap; Agent workers and tool processes own their own recycle, termination, or close lifecycle. Linux cgroup memory describes the complete service and is used for attribution, diagnostics, and admission control, but service-only pressure never triggers Control Plane GC.

After each model/tool turn, and at selected checkpoints during a long model stream, the session runtime samples Control Plane memory. Concurrent ordinary requests share one in-flight collection. Once a GC has run, later collection decisions observe `SYNERGY_SESSION_GC_MIN_INTERVAL_MS` (default `10000`). If a Linux release request arrives while a collection is running, the runtime keeps one highest-priority successor. After the active collection completes, that successor takes a fresh memory sample and runs the decision again against current process ownership, active-stream safety, and normal/full-GC cooldown state. Linux turn/tool release signals are coalesced outside the settlement path. Soft process pressure requests asynchronous GC:

- `SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES` (default `1.25 GiB`)
- `SYNERGY_SESSION_GC_EXTERNAL_SOFT_BYTES` (default `1 GiB`)
- `SYNERGY_SESSION_GC_ARRAY_BUFFERS_SOFT_BYTES` (default `1 GiB`)

Critical Control Plane pressure is reported when its RSS, JavaScript heap, external allocations, or ArrayBuffers cross the configured thresholds. At a Linux release boundary with no active provider stream, critical process pressure may request synchronous full GC; this path has an independent `SYNERGY_SESSION_GC_FULL_MIN_INTERVAL_MS` cooldown (default `30000`). During an active stream, on non-Linux systems, or while the full-GC cooldown is active, collection remains asynchronous.

- `SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES` (default `9.5 GiB`)
- `SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES` (default `1.75 GiB`)
- `SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES` (default `1.5 GiB`)
- `SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES` (default `8 GiB`)

Service pressure is classified independently from cgroup working set and current charge:

- `SYNERGY_SESSION_GC_CGROUP_SOFT_BYTES` (default 60% of `memory.high`, then `memory.max`, then `11 GiB`)
- `SYNERGY_SESSION_GC_CGROUP_CRITICAL_BYTES` (default `memory.high`, then 90% of `memory.max`, then `10.5 GiB`)

Soft service pressure compares the cgroup working set with the soft threshold. Critical service pressure compares the current cgroup charge with the critical threshold.

Soft pressure is evidence for GC and turn-size telemetry only. Automatic heap snapshots are not taken on the soft path because snapshot generation itself allocates and can worsen allocation failures. Use ordinary resource samples, MessageCache counters, and LLM turn size metrics for diagnosis.

On Linux, every resource sample retains cgroup current charge, `memory.high`, `memory.max`, `memory.peak`, and lifetime OOM counters. In the metrics table, current is written at every resource interval, while the static high/max limits are written only when they change and at a low-frequency heartbeat controlled by `SYNERGY_CGROUP_STATIC_HEARTBEAT_MS` (default `300000`, minimum `30000`). Peak, swap, anonymous/file/kernel/slab breakdowns, reclaimable bytes, working set, `memory.events`, and PSI `some`/`full` pressure are sampled independently at `SYNERGY_CGROUP_DETAIL_INTERVAL_MS` (default `60000`, clamped to `30000`–`60000`); zero event and stall deltas are omitted. JSC and allocator gauges plus the twelve largest and fastest-growing object types are attempted at most once per `SYNERGY_LINUX_HEAP_STATS_INTERVAL_MS` (default `60000`), including after failed `heapStats()` reads. The first successful object-type sample establishes the growth baseline and reports zero deltas. These bounded diagnostics explain which boundary retained memory without turning stable cgroup values or repeated heap-stat failures into high-volume metric rows.

Cortex also uses the shared soft and critical classifications to constrain new child-task admission to four or two tasks, respectively. Its earlier 1 GiB and 2 GiB ArrayBuffer thresholds remain in place. This admission control leaves running tasks alone and lets queued tasks resume after pressure falls.

When the runtime reports an allocation failure (`Out of memory`, `Array buffer allocation failed`, heap-limit errors, or `ENOMEM`/cannot-allocate variants, including nested causes), the processor emits one deduplicated, bounded incident before persisting the ordinary turn error. Capture stays light: it samples current process memory, recent server resource rows, running spans from the last five minutes, MessageCache counters and entry sizes, and active/recent turn-size summaries without running GC or generating heap snapshots. It caps each collection, omits prompt/tool/response content and runtime identifiers from nested data, and raises `PERF_PROCESS_OUT_OF_MEMORY`.

Experience re-encode jobs use the combined process and service critical thresholds to pause new item claims and resume automatically after pressure subsides. Process pressure may request Control Plane GC before the wait; cgroup-only pressure enters the wait without collecting the Control Plane. `SYNERGY_REENCODE_PRESSURE_POLL_MS` controls the pause polling interval (default `30000`).

## Performance and diagnostics APIs

The server exposes local-first endpoints under `/global/performance`:

The performance summary reports Agent worker and Policy worker pool capacity, readiness, active/queued work, queued bytes, RSS, and heap-used bytes alongside ToolTask scheduler state. Policy timeout, crash, recycle, startup-circuit, queue-wait, and conservative-fallback metrics are written only by the Control Plane; Policy processes do not initialize an observability store.

- `GET /global/performance/summary`
- `GET /global/performance/inflight`
- `GET /global/performance/timeline`
- `GET /global/performance/traces`
- `GET /global/performance/traces/:traceId`
- `GET /global/performance/issues`
- `GET /global/performance/config`
- `PATCH /global/performance/config`
- `POST /global/performance/browser-metrics`
- `POST /global/performance/analysis`
- `GET /global/performance/analysis/:sessionID`
- `POST /global/performance/analysis/:sessionID/cancel`
- `GET /global/performance/events`

The support diagnostics summary is `GET /global/diagnostics` and returns the typed `DiagnosticsSummary` schema. `synergy diagnostics` creates a tar.gz package containing `summary.json`, indexed `events.jsonl`, `issues.json`, `inflight.json`, `resources.json`, redacted logs, process registry state, server lock information, pending-session metadata, and plugin runtime state when available.

Stable error codes use the `PERF_*` prefix. `GET /global/performance/summary` includes current runtime retention counters under `runtime.sessionRuntimes` and `runtime.cortexTasks`, aggregate MessageCache counters under `runtime.messageCache`, active turn/stream counts under `runtime.llmTurns`, and current `heapUsed`, `external`, and `arrayBuffers` resource gauges. Performance Analyze receives those same bounded runtime aggregates and memory categories. `GET /global/performance/config` returns `{ config, defaults, sources }`; generated SDK callers use `client.performance.config.get()` and `client.performance.config.update()` for that endpoint.

## External OSS tooling

The runtime dashboard does not require SaaS or external agents. For repeatable local validation, use open-source tools around a running Synergy server:

```bash
# Bun-native lightweight smoke load
bun script/performance-load.ts

# oha or bombardier wrapper if either tool is installed
SYNERGY_PERF_BASE_URL=http://127.0.0.1:5817 script/performance-http.sh

# hyperfine for command startup comparisons
script/performance-hyperfine.sh

# Playwright trace/HAR smoke capture for a running Web app
SYNERGY_PERF_APP_URL=http://127.0.0.1:3000 bun script/performance-playwright.ts

# Bun microbenchmark harness for hot pure performance helpers
bun script/performance-benchmark.ts

# Lighthouse CI config for opt-in browser performance checks
npx lhci autorun --config=lighthouserc.performance.cjs

# Rollup visualizer report mode for app bundles, opt-in only
bun packages/app/script/visualizer-report.ts
SYNERGY_BUNDLE_VISUALIZER=1 bun run --cwd packages/app build
```

k6 can be used with `script/performance-k6.js` when teams already rely on it, but it is not a runtime dependency because of its AGPL license.

For browser investigations, use Playwright traces/HAR, Lighthouse CI against the Web app, and Rollup/Vite visualizer reports in development workflows. These tools complement the local Performance panel; they do not replace runtime telemetry.
