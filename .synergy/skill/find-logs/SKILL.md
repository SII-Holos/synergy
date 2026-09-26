---
name: find-logs
description: Identify the exact Synergy backend and SYNERGY_HOME behind a local or managed runtime, inspect its logs and structured traces, and gather runtime evidence for failures. Use for errors, crashes, stuck sessions, native Workspace claim recovery, tool calls, traces, daemon startup, performance incidents, multiple bun dev servers, reproducing state-dependent bugs, or adding temporary diagnostic instrumentation in an isolated worktree/runtime.
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

For managed Desktop startup, first isolate the latest `starting`/exit interval in Electron's server log. Historical plugin, channel or login errors in an appended log do not establish the current failure. Correlate the current launch's structured maintenance begin/stage/terminal events with the backend failure: ordinary health timeout, item-progress inactivity and a fixed SQLite maintenance deadline are different contracts. A journal checkpoint or database rewrite can be active without increasing an item count. Record the operation, last stage, elapsed time and budget; do not infer the engine's exact stuck stage when older logs contain only a migration step.

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

When a model call fails, logs alone may not carry the cause. The persisted error and the authoritative call record do. Read the assistant message's structured error first: an `APIError` carries `isRetryable` and a `metadata` map that includes `networkKind`, `category`, `code`, `syscall`, and `endpointHost` when the failure was classified as a network failure. `networkKind: "indeterminate"` with `category: "tls-verification"` means a TLS verification failure with no attributing reason code from the runtime — the runtime drops the code precisely when it cannot attribute the failure. `endpointHost` names the host the request was sent to, which distinguishes an endpoint problem from a local interception problem; it carries only the host, never a path or credential.

A `UnknownError` with no metadata means the failure reached neither the network classifier nor a structured provider branch; treat that as "unrecognized" and look for a nested cause rather than assuming a deterministic configuration error. When a terminal error is attributed to a task, confirm how it was surfaced: a Cortex task records `cortex.status = "error"` plus the task error string, and `SessionTerminalError` wraps the original terminal assistant error.

Compare a failing call against its siblings before concluding the endpoint is broken. In the rollout records for the same run, a healthy call has `status: "completed"` with a `complete` response whose `bytes` match a normal payload; a transport break shows a small `partial` response with the error attached. If comparable requests immediately before and after succeeded, the failure is transient, not a persistent configuration fault.

For a local interception hypothesis, check name resolution and routing before editing timeouts: a provider endpoint resolving into `198.18.0.0/15` or `240.0.0.0/4` indicates fake-IP DNS from a transparent proxy, and a default route bound to a `utun*`/`tun*` device indicates TUN-mode interception. Compare the certificate actually presented against the system trust store — genuine end-to-end TLS with a public issuer means the interception is at the DNS/routing layer rather than a TLS replacement. `synergy doctor` reports both checks directly.

Never write a raw provider URL into a report, commit, or issue while doing this: provider keys are commonly embedded in the URL path, so only the host is publishable.

For a long-running local migration that fails a request deadline, correlate the failure with system sleep/wake events before changing query timeouts. On macOS, inspect the relevant time window in `pmset -g log`. An idle-sleep inhibitor does not guarantee execution through lid closure or forced sleep. Resume only after confirming the previous owner exited, reuse committed migration checkpoints, and repeat checks required by the new transaction; do not skip integrity verification or launch a second owner.

## Recover Native Workspace Coordination

Use this procedure for persistent native write contention or a claims-ledger parse failure. Read [Workspace ownership](../../../docs/architecture/workspace-and-files.md#workspace-write-coordination) before classifying the failure. An agent must never stop, restart or repair the instance carrying its current task; host maintenance belongs in a separately authorized operator window.

1. Distinguish an ordinary `WorkspaceBusyError` from JSON/schema failure or an unverifiable native process tree. Correlate the owning Runtime, claim kind/state, native ownership mechanism, PID/start identity and completion evidence. A shell exit, closed terminal connection, old PID or empty process-list snapshot does not prove all descendants exited.
2. Resolve the OS-account coordination directory from [the owning implementation](../../../packages/runtime-local/src/file/mutation.ts), not `SYNERGY_HOME`, `TMPDIR` or `TEMP`. POSIX uses `/tmp/synergy-file-locks-<uid>`; Windows uses `.synergy-file-locks` under the OS-reported user profile. The affected ledger is `workspace-claims-v1.json`. Verify directory ownership, privacy and absence of symlinks before accessing it; do not bypass a failed check with a permission change.
3. Keep a private copy of the evidence before maintenance. The ledger contains owner identifiers, tokens, paths and native receipt references; publish only redacted counts, kinds and failure categories. Read a copy for diagnosis. `WorkspaceCoordinator.inspect()` can reap claims and persist the ledger, so it is not a read-only file viewer. Do not create a replacement coordinator directory or change temporary-directory variables to evade an existing claim.
4. For a verified live owner, use its normal cancellation or terminal shutdown and wait for complete native cleanup. Closing only the browser connection is insufficient. Leave other Sessions and Runtime instances alone; a host-wide writer can legitimately block unrelated directories. Verify a subsequent small native write after the owner finishes.
5. For a valid Linux claim whose supervisor died without a completion receipt, retain the ledger and receipt. Arrange a host reboot with the operator, then verify the host boot identity changed. The native inspector treats an old-boot tree as exited, permitting normal coordinator reclamation; a Runtime restart alone does not. Do not forge a completion receipt, remove the claim by PID or impose an age-based expiry.
6. For a malformed ledger, treat every recorded owner as unknown. Arrange host maintenance with automatic Synergy startup suspended, preserve a private evidence copy and reboot the host. Before any Runtime or native worker starts again, recheck the coordination directory and move only the affected regular ledger file to a new private quarantine filename. Keep its bytes and the rest of the directory intact; do not delete lock files, receipts or the whole directory. Start one Runtime, which creates a new ledger on first admission. If the host cannot be made exclusively offline after reboot, retain the failure and escalate instead of replacing the ledger.

Verify recovery through a disposable, explicitly selected Workspace: create a uniquely named file, read its exact bytes, conditionally edit it, read it again and remove only that test file. Confirm a second operation is admitted after the first completes, the Runtime remains healthy, and any failed operation history still reports its actual result. Resume the other instances after this check. Recovery restores admission; it does not replay interrupted commands or manufacture missing snapshot evidence.

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
