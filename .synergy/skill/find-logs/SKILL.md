---
name: find-logs
description: Diagnose Synergy runtime failures with managed-service logs, development logs, structured observability events, status inspection, and redacted diagnostics packages. Use for errors, crashes, stuck sessions, tool calls, traces, daemon startup, performance incidents, and requests to locate or filter Synergy logs.
---

# Diagnose with Logs and Traces

## Identify the Runtime

1. Determine whether the target is the managed product runtime, a source `bun dev` runtime, or an isolated `SYNERGY_HOME`.
2. Preserve that environment on every command. Do not accidentally query the active production home while diagnosing an isolated test.
3. Start with supported commands rather than guessing file paths:

```bash
synergy status --verbose
synergy logs --tail 200
synergy logs --dev --tail 200
```

## Narrow the Evidence

Filter normal logs by level, service, or text:

```bash
synergy logs --level ERROR --tail 200
synergy logs --service session --grep "compaction|timeout"
synergy logs --dev --follow --service cortex
synergy logs --archive 0 --tail 500
```

Filter structured observability events when a session, trace, or tool call is known:

```bash
synergy logs --session <session-id> --since 2h
synergy logs --trace-id <trace-id> --json
synergy logs --tool-call <call-id> --since 30m --json
```

Correlate by timestamp, session ID, call ID, trace ID, service, and terminal state. Trace the earliest causal error rather than reporting every downstream cancellation.

## Read Files Only When Needed

Use [Storage and paths](../../../docs/reference/storage-and-paths.md) for the current root layout. Normal logs live under `Global.Path.log`; daemon output and structured traces live under `Global.Path.state`. Resolve the actual root from `SYNERGY_HOME` before using `rg`, `tail`, or JSONL tools directly.

Do not edit, truncate, rotate, or delete live logs or runtime locks during diagnosis.

## Package Diagnostics

Create a redacted local bundle only when the user needs a shareable artifact:

```bash
synergy diagnostics --session <session-id> --since 2h --output <path>.tar.gz
```

Inspect its `summary.json` and filtered trace before sharing. The bundle sanitizes text, but still review it for project names, commands, paths, and business data. Never attach credentials or raw config.

For performance incidents, also read [Performance observability](../../../docs/operations/performance-observability.md) and query the performance API or panel rather than inferring resource behavior from log volume alone.

## Report

Return the target runtime, time window, filters, causal event sequence, likely owner module, confidence, and next verification step. Summarize or redact absolute paths, secrets, session content, and local identifiers in outbound text.
