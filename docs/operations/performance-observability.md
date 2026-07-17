# Performance Observability

Synergy includes a first-class Performance settings panel for local runtime, frontend, network, and resource performance. Performance is the user-facing read model over Synergy's indexed observability store. Observability owns the canonical telemetry foundation: context propagation, redaction, events, metrics, spans, issues, resource samples, migrations, and diagnostics. Diagnostics is a support API and package capability backed by the same indexed data plus redacted logs and runtime inspection.

## What the Performance panel shows

Open the **Performance** workbench panel from the sidebar to inspect the default recent monitoring window. The panel summarizes:

- health status, health score, and open performance issues;
- HTTP request count, error rate, and p50/p95/p99 latency;
- session turn latency, inflight or stale operations, LLM calls, tool calls, and repeated tool-failure issues, including model calls to unknown tools, invalid tool arguments, tools hidden or blocked by session mode and permission rules, and executor failures;
- CPU, memory, event-loop lag, and app-owned disk IO;
- registered tool child process count, RSS total, and top child process memory contributors;
- session runtime counts and retained Cortex task counts, including retained prompt/output/error character totals;
- frontend session-switch timing, token receive/apply/paint timing, browser Web Vitals, ResourceTiming, UserTiming, long tasks, and long animation frames when the browser supports them;
- slow routes, sessions, tools, providers, storage operations, child processes, and trace drill-downs.

The Web panel loads a snapshot when it opens or when the selected time range changes. The snapshot remains stable until **Refresh** is selected; the panel does not poll, refresh after visibility changes, subscribe to live Performance events, or refetch charts as they enter the viewport.

Every record is stored with low-cardinality attribution such as source, module, Scope/session/request/tool/provider/process IDs, correlation IDs, trace IDs, span IDs, and safe labels. Sensitive prompt, response, header, credential, environment, raw body, and file-content data is redacted or omitted before it reaches public read models or diagnostics packages.

Permission evaluation logs contain only the permission name, requested pattern length, and merged ruleset count. Raw requested patterns and merged permission rules are intentionally omitted so repeated authorization checks remain bounded and do not expose command or path contents through observability.

Server resource samples are kept separate from registered tool child process samples. Linux hosts report child RSS from `/proc/<pid>/status`; unsupported hosts still report registered child process counts. Stale registered child processes whose pid no longer exists are settled into finished process history before new resource samples are stored. Each live process retains at most 200,000 output characters in bounded segments; full output and the 2,000-character tail are materialized only when a consumer reads them.

## Local storage

Canonical telemetry is stored locally in SQLite with WAL mode:

```txt
~/.synergy/state/observability/observability.sqlite
```

The indexed store contains `obs_*` tables for metrics, spans, events, issues, resource samples, browser batches, and metadata. Runtime queries, diagnostics summaries, and diagnostics packages read this store instead of scanning trace files. Optional JSONL mirror files can be enabled for debugging exports, but they are not the runtime query source.

Startup migrations import the previous indexed performance store when it exists. Legacy schema detection stays inside the observability migration boundary, copied rows are redacted into the canonical `obs_*` tables in bounded batches, and the central migration runner records completion only after the upgrade succeeds. Runtime readers use only the canonical store.

The configured SQLite limit applies to the combined database, WAL, and shared-memory footprint. Maintenance checkpoints WAL, incrementally reclaims free pages, and removes the globally oldest eligible historical rows in bounded batches. Running spans and open issues are protected from size eviction. If protected state or the minimum schema footprint prevents the configured limit from being reached, diagnostics expose the remaining excess instead of silently deleting live operational state. Full `VACUUM` is reserved for the one-time migration that enables incremental auto-vacuum on an existing database.

High-frequency count signals such as LLM stream output, child-process output, and storage-operation counts are aggregated by attribution key before SQLite flush. Stream chunk-gap and throughput signals are summarized once per stream and output kind rather than written for every chunk. This keeps writer queue depth bounded without removing trace, Scope, session, message, provider, tool, or process attribution.

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

## Session memory pressure

After each model/tool turn, the session runtime samples process memory and may run Bun GC before the loop starts another turn. Normal GC is throttled by `SYNERGY_SESSION_GC_MIN_INTERVAL_MS` (default `10000`). Critical pressure bypasses that interval when RSS, ArrayBuffers, or Linux cgroup memory crosses the configured thresholds:

- `SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES` (default `9.5 GiB`)
- `SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES` (default `8 GiB`)
- `SYNERGY_SESSION_GC_CGROUP_CRITICAL_BYTES` (default cgroup `memory.high`, then 90% of `memory.max`, then `10.5 GiB`)

## Performance and diagnostics APIs

The server exposes local-first endpoints under `/global/performance`:

- `GET /global/performance/summary`
- `GET /global/performance/inflight`
- `GET /global/performance/timeline`
- `GET /global/performance/traces`
- `GET /global/performance/traces/:traceId`
- `GET /global/performance/issues`
- `GET /global/performance/config`
- `PATCH /global/performance/config`
- `POST /global/performance/browser-metrics`
- `GET /global/performance/events`

The support diagnostics summary is `GET /global/diagnostics` and returns the typed `DiagnosticsSummary` schema. `synergy diagnostics` creates a tar.gz package containing `summary.json`, indexed `events.jsonl`, `issues.json`, `inflight.json`, `resources.json`, redacted logs, process registry state, server lock information, pending-session metadata, and plugin runtime state when available.

Stable error codes use the `PERF_*` prefix. `GET /global/performance/summary` includes current runtime retention counters under `runtime.sessionRuntimes` and `runtime.cortexTasks`. `GET /global/performance/config` returns `{ config, defaults, sources }`; generated SDK callers use `client.performance.config.get()` and `client.performance.config.update()` for that endpoint.

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
