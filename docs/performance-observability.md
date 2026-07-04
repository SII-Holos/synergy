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

Stable error codes use the `PERF_*` prefix.

## External OSS tooling

The runtime dashboard does not require SaaS or external agents. For repeatable local validation, use open-source tools around a running Synergy server:

```bash
# Bun-native lightweight smoke load
bun script/performance-load.ts

# oha or bombardier if installed
SYNERGY_URL=http://127.0.0.1:5817 oha -z 30s -c 16 "$SYNERGY_URL/global/health"
SYNERGY_URL=http://127.0.0.1:5817 bombardier -d 30s -c 16 "$SYNERGY_URL/global/health"

# hyperfine for command startup comparisons
hyperfine 'bun dev send "ping"'
```

k6 can be used from an external checkout when teams already rely on it, but it is not a Synergy runtime dependency because of its AGPL license.

For browser investigations, use Playwright traces/HAR, Lighthouse CI against the Web app, and Rollup/Vite visualizer reports in development workflows. These tools complement the local Performance panel; they do not replace runtime telemetry.
