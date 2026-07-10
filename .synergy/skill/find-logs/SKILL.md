---
name: find-logs
description: "Guide for finding and reading Synergy logs, observability traces, and diagnostics. Use when debugging runtime issues, finding error messages, tracing session execution, or packaging diagnostics. Triggers: 'log', 'logs', 'logging', 'debug log', 'where are logs', 'find error', 'trace', 'diagnostics', 'observability'."
---

# Finding and Reading Synergy Logs

## Log File Locations

| Scenario                       | Path                                       | Notes                               |
| ------------------------------ | ------------------------------------------ | ----------------------------------- |
| Development (`bun dev server`) | `~/.synergy/log/dev.log`                   | Single file, flushed on every write |
| Production (daemon)            | `~/.synergy/log/{ISO8601}.log`             | e.g. `2026-07-10T160000.log`        |
| Daemon service output          | `~/.synergy/state/daemon/logs/server.log`  | 10 MB rotation, keeps 5 archives    |
| Dev archives                   | `~/.synergy/log/dev.{YYYYMMDD-HHMMSS}.log` | Max 10 files or 200 MB total        |

**Rotation behavior**:

- On dev restart, `dev.log` → archived to `dev.{YYYYMMDD-HHMMSS}.log`. Up to 10 kept.
- On production startup, oldest timestamped logs are pruned, keeping newest 5.
- Daemon log rotates at 10 MB (checked every 60 seconds).

## Log Format

```
LEVEL YYYY-MM-DDTHH:mm:ss +NNNms service=name key=value message text
```

- **LEVEL**: `DEBUG`, `INFO`, `WARN`, `ERROR`
- **Timestamp**: ISO 8601 to second precision
- **`+NNNms`**: Milliseconds since previous log line (delta for performance spotting)
- **Tag pairs**: `service=server`, `sessionID=ses_abc`, `callID=call_xyz`, etc.
- **Message**: Control chars stripped, newlines escaped to `\n`
- **Redaction**: Keys matching `token`, `secret`, `password`, `authorization`, `api_key`, `credential`, and similar patterns are replaced with `[redacted]`

## How to Filter Logs

```bash
# Only errors
rg "^ERROR" ~/.synergy/log/dev.log

# By session
rg "sessionID=ses_abc" ~/.synergy/log/dev.log

# Real-time tail
tail -f ~/.synergy/log/dev.log

# Last 100 lines
tail -100 ~/.synergy/log/dev.log

# Search for a module's logs
rg "service=cortex" ~/.synergy/log/dev.log
rg "service=agent" ~/.synergy/log/dev.log
rg "service=server" ~/.synergy/log/dev.log

# Time range (replace date as needed)
rg "2026-07-10T16:" ~/.synergy/log/dev.log
```

## Log Levels

Priority chain (highest wins):

1. `--log-level` CLI flag (e.g., `bun dev server --log-level DEBUG`)
2. `LOG_LEVEL` environment variable
3. Config `general.logLevel` in `~/.synergy/config/synergy.d/00-general.jsonc`
4. Default: `DEBUG` for local/dev builds, `INFO` for production

```bash
# Force DEBUG level
LOG_LEVEL=DEBUG bun dev server
```

## Log API (for coding)

Code lives in `packages/synergy/src/util/log.ts`.

```ts
import { Log } from "@/util/log"

// Create a logger for your domain
const log = Log.create({ service: "my-feature" })

log.debug("state changed", { key: value })
log.info("operation complete", { count: 42 })
log.warn("deprecated call", { caller: "foo" })
log.error("unexpected condition", { error: err.message })

// Auto-timed blocks (uses `using` dispose)
{
  using timer = log.time("expensive operation")
  await doWork()
  // "expensive operation took 123ms" auto-logged on scope exit
}
```

Key API:

- `Log.init({ print, dev, level })` — server startup, called once
- `Log.create({ service: "name" })` — cached by service name
- `Log.file()` — returns current log file path
- `Log.Default` — singleton `service=default` logger

## Observability Traces

A separate **structured event tracing** system for performance analysis and call-chain tracking. Independent from the log subsystem.

### Location

```
~/.synergy/state/observability/traces/{YYYY-MM-DD}.jsonl
```

One JSONL file per day. Each line is a JSON event object.

### Querying

The `Observability.query()` API filters by `traceId`, `sessionID`, `callID`, `since`, `level`, `limit`:

```ts
import { Observability } from "@/observability"

const traces = await Observability.query({
  sessionID: "ses_abc",
  since: Date.now() - 3600_000, // last hour
  limit: 100,
})
```

From a shell, you can grep the JSONL directly:

```bash
# Find all events for a session
rg "ses_abc" ~/.synergy/state/observability/traces/2026-07-10.jsonl

# Find all tool calls
rg '"type":"tool_call"' ~/.synergy/state/observability/traces/2026-07-10.jsonl
```

### Retention

- 7 days default, 250 MB max total
- Cleanup runs on every `emit()`, throttled to once per 60 seconds
- Code: `packages/synergy/src/observability/index.ts`

## Diagnostics Package

Create a comprehensive diagnostics bundle for sharing or filing issues:

```bash
# CLI
synergy diagnostics

# HTTP
curl http://localhost:{port}/observability/diagnostics
```

The `.tar.gz` includes:

- All log files (current, dev, daemon, dev archives)
- Trace JSONL files (optionally filtered by `sessionID`)
- `summary.json`: lock file state, running processes, pending reply sessions
- Plugin runtime state

Code: `packages/synergy/src/observability/diagnostics.ts`

## Key Environment Variables

| Variable            | Effect                                        |
| ------------------- | --------------------------------------------- |
| `SYNERGY_HOME`      | Override home base (`$SYNERGY_HOME/.synergy`) |
| `SYNERGY_TEST_HOME` | Test override (checked before `os.homedir()`) |
| `LOG_LEVEL`         | Set `DEBUG` / `INFO` / `WARN` / `ERROR`       |
| `SYNERGY_DAEMON=1`  | Daemon mode, different log path               |

## Quick Reference: Important Paths

| Path                                      | Purpose                                        |
| ----------------------------------------- | ---------------------------------------------- |
| `~/.synergy/`                             | Root of all Synergy data                       |
| `~/.synergy/log/`                         | All log files                                  |
| `~/.synergy/data/`                        | Session/message/permission/agenda JSON storage |
| `~/.synergy/state/`                       | Daemon state, LSP PIDs, observability traces   |
| `~/.synergy/state/observability/traces/`  | Daily JSONL trace files                        |
| `~/.synergy/state/daemon/logs/server.log` | Daemon server log                              |
| `~/.synergy/config/synergy.d/`            | Config domain files                            |
| `~/.synergy/data/auth/`                   | API keys, provider OAuth, MCP credentials      |
