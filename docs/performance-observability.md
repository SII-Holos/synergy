# Performance observability

Synergy includes a first-class Performance settings panel for live runtime, frontend, network, and resource performance. Performance is the user-facing monitoring surface. Observability remains the raw local trace/event and collection-configuration layer. Diagnostics remains a hidden support API and package capability for support bundles.

## What the Performance panel shows

Open **Settings → Runtime → Performance** to inspect the default recent monitoring window. The panel summarizes:

- health status, health score, and open performance issues;
- HTTP request count, error rate, and p50/p95/p99 latency;
- session turn latency, LLM calls, and tool calls;
- CPU, memory, event-loop lag, and app-owned disk IO;
- browser Web Vitals, ResourceTiming, UserTiming, long tasks, and long animation frames when the browser supports them;
- slow routes, sessions, tools, providers, storage operations, and trace drill-downs.

Every metric, span, and issue is stored with low-cardinality attribution such as source, module, Scope/session/request/tool/provider/process IDs, trace IDs, span IDs, and safe labels. Sensitive prompt, response, header, credential, and file-content data is redacted or omitted.

## Local storage

Structured performance data is stored locally in SQLite with WAL mode:

```txt
~/.synergy/state/observability/performance/performance.sqlite
```

The existing JSONL traces remain under the observability trace directory for compatibility and support packages. Performance retention is bounded by runtime observability config and defaults to local production-safe windows.

## Runtime config

Performance settings extend the existing runtime observability domain in `120-runtime.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "performance": {
      "enabled": true,
      "samplingRate": 1,
      "metricRetentionMs": 3600000,
      "traceRetentionMs": 1800000,
      "resourceSampleIntervalMs": 5000,
      "dashboardRefreshMs": 5000,
      "storage": {
        "sqliteEnabled": true,
        "maxSqliteBytes": 262144000,
      },
    },
  },
}
```

Use the generated SDK for non-streaming Performance API calls. The Performance SSE stream is `/global/performance/events` and emits refresh hints plus heartbeat events; clients should refetch summary after reconnect.

## Session memory pressure

After each model/tool turn, the session runtime samples process memory and may run Bun GC before the loop starts another turn. Normal GC is throttled by `SYNERGY_SESSION_GC_MIN_INTERVAL_MS` (default `10000`). Critical pressure bypasses that interval when RSS, ArrayBuffers, or Linux cgroup memory crosses the configured thresholds:

- `SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES` (default `9.5 GiB`)
- `SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES` (default `8 GiB`)
- `SYNERGY_SESSION_GC_CGROUP_CRITICAL_BYTES` (default cgroup `memory.high`, then 90% of `memory.max`, then `10.5 GiB`)

## Performance API

The server exposes local-first endpoints under `/global/performance`:

- `GET /global/performance/summary`
- `GET /global/performance/timeline`
- `GET /global/performance/traces`
- `GET /global/performance/traces/:traceId`
- `GET /global/performance/issues`
- `GET /global/performance/config`
- `PATCH /global/performance/config`
- `POST /global/performance/browser-metrics`
- `GET /global/performance/events`

Stable error codes use the `PERF_*` prefix. `GET /global/performance/config` returns `{ config, defaults, sources }`; generated SDK callers use `client.performance.config.get()` and `client.performance.config.update()` for that endpoint.

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
