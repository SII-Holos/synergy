---
name: find-logs
description: Identify the exact Synergy backend and SYNERGY_HOME behind a local or managed runtime, inspect its logs and structured traces, and gather runtime evidence for failures. Use for errors, crashes, stuck sessions, tool calls, traces, daemon startup, performance incidents, multiple bun dev servers, reproducing state-dependent bugs, or adding temporary diagnostic instrumentation in an isolated worktree/runtime.
---

# Diagnose the Running Synergy Instance

## Identify the Backend Before Reading Logs

Do not assume the default home or the most recently modified `dev.log` belongs to the failing client. One machine can run multiple Synergy backends, each with its own parent `SYNERGY_HOME`, `.synergy` root, runtime lock, state, and logs.

1. Record the failing client, backend URL or port, approximate failure time, launch mode, and known development-home label. Keep local identifiers out of commits and remote reports.
2. If the backend port is known, resolve its listener and inspect only that process:

```bash
TARGET_PORT=<backend-port>
lsof -nP -iTCP:"$TARGET_PORT" -sTCP:LISTEN
ps -p <pid> -o pid=,ppid=,etime=,command=
lsof -nP -p <pid> | rg '/\.synergy/(log|state)/'
```

The open `.../.synergy/log/dev.log` file usually identifies the parent `SYNERGY_HOME` for a source server without exposing the process's complete environment. If no log file is open, match the PID against `state/daemon/runtime-lock.json` under the small set of known candidate homes. Do not search credential directories or print a full process environment.

3. Set the resolved parent home explicitly and verify the lock, process, and listening port agree:

```bash
INSTANCE_HOME=<resolved-parent-home>
SYNERGY_HOME="$INSTANCE_HOME" synergy status --verbose
curl -fsS "http://127.0.0.1:$TARGET_PORT/global/health"
jq '{pid, startedAt, cwd, mode, command}' \
  "$INSTANCE_HOME/.synergy/state/daemon/runtime-lock.json"
```

The root is `$INSTANCE_HOME/.synergy/`; `SYNERGY_HOME` names its parent. A lock records PID, start time, server/daemon mode, command, and working directory. `status --verbose` also reports the lock's listening ports, but its configured daemon health URL can differ from an explicit `bun dev --server-port`; verify that development port directly. Treat a PID or port mismatch as evidence that the wrong instance was selected or that the lock is stale. Resolve that mismatch before continuing.

If the process was launched with `--print-logs`, logs go to its terminal instead of a normal log file. Locate the owning terminal or rerun only an isolated test instance without that flag; do not restart the runtime carrying the current task.

## Read the Correct Evidence

The CLI is the supported inspection entry point once the home is known:

```bash
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --dev --tail 200
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --dev --follow --service cortex
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --dev --level ERROR --grep 'timeout|compaction'
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --dev --archive 0 --tail 500
```

For normal `bun dev server`, `web`, or external-server Desktop runs, the current file is `$INSTANCE_HOME/.synergy/log/dev.log`. Restarting the development server archives the previous file as `dev.<timestamp>.log`, so inspect the archive covering the failure time after a restart. Direct file access is often the fastest local path:

```bash
LOG_FILE="$INSTANCE_HOME/.synergy/log/dev.log"
tail -F "$LOG_FILE"
rg '^ERROR|service=(server-runtime|session|cortex)' "$LOG_FILE"
```

For an installed managed service, `synergy logs` reads `$INSTANCE_HOME/.synergy/state/daemon/logs/server.log`, where the service captures the server's printed output. Resolve current paths from [Storage and paths](../../../docs/reference/storage-and-paths.md) rather than copying paths from an unrelated home.

Use structured observability when a trace, session, or tool call is known. These commands still require the resolved home:

```bash
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --session <session-id> --since 2h
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --trace-id <trace-id> --json
SYNERGY_HOME="$INSTANCE_HOME" synergy logs --tool-call <call-id> --since 30m --json
```

Correlate backend PID and port, server start time, reproduction time window, service, session, call, and trace. Find the earliest causal divergence or error; downstream cancellations are usually consequences, not separate root causes.

## Escalate to Runtime Reproduction

Static code inspection establishes hypotheses. It is not sufficient evidence for bugs that depend on persisted state, ordering, concurrency, streaming, external responses, frontend/backend synchronization, or process lifecycle.

When the task authorizes code changes and existing evidence cannot distinguish the hypotheses:

1. Load `architecture` to identify the ownership boundary, then inspect the current checkout according to `git-guide`. Temporary instrumentation may be edited there when it preserves unrelated work; use a task-owned worktree when concurrent changes need isolation.
2. Load `develop-synergy`; start the source checkout with a new isolated `SYNERGY_HOME` and explicit free ports. Never reuse, restart, or mutate the backend carrying the current task.
3. Reproduce the original behavior before editing when possible. Record the exact action, expected invariant, observed state, server start time, and a narrow log/trace window.
4. Add the smallest temporary observation that separates the hypotheses: structured logs around state transitions, counters, timing, assertions, or a focused diagnostic endpoint/test. Prefer the owning domain's `Log.create({ service: ... })` pattern and log identifiers or derived metadata instead of payload contents.
5. Restart only the isolated backend when required, repeat the same reproduction, and compare the before/after event sequence. Inspect persisted state and frontend/runtime state only at the boundary relevant to the hypothesis.
6. Turn the confirmed failure into a behavioral test before fixing it. Remove diagnostic-only logs and endpoints before committing; retain observability only when it is a durable, redacted product signal with an intentional schema and verification.

Never log credentials, tokens, authorization headers, cookies, raw config, provider endpoints, full prompts/messages, file contents, or secret-like values. Do not truncate, rotate, delete, or hand-edit live logs, locks, or runtime state during diagnosis.

## Package and Report

Create a redacted diagnostics bundle only when a shareable artifact is needed:

```bash
SYNERGY_HOME="$INSTANCE_HOME" synergy diagnostics \
  --session <session-id> --since 2h --output <path>.tar.gz
```

Review `summary.json` and the filtered trace before sharing. Sanitization reduces risk but does not make project names, commands, paths, IDs, or business data public-safe. For performance incidents, also read [Performance observability](../../../docs/operations/performance-observability.md) instead of inferring resource behavior from log volume.

Report the identified runtime label and mode, backend port, time window, evidence sources and filters, reproduction, earliest causal event, confirmed owner boundary, confidence, and next verification step. Redact absolute paths, secrets, session content, and local identifiers from commits, PRs, issues, and other outbound text.
