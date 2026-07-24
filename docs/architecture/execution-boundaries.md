# Execution Boundaries

Synergy evaluates every tool call at a centralized Control Plane execution boundary. Tool availability, model presentation, capability classification, approval, scheduling, sandboxing, physical execution, and result settlement are distinct stages; no individual tool is allowed to invent a parallel permission model.

## Execution Pipeline

For each model turn, the session tool resolver collects ephemeral tools, built-in and plugin tools, and MCP tools. It filters that set by agent visibility and session exposure, then emits two separate products:

- `ToolCatalog` definitions containing only serializable IDs, descriptions, and JSON Schemas for the Agent worker and model;
- Control Plane execution callbacks plus an executor-class mapping for `ToolScheduler`.

The Agent worker never receives an `execute()` callback. It emits proposed calls and completes its provider turn. After the worker stream is disposed, the Control Plane applies the runtime pipeline:

1. verify that the current execution context permits the tool
2. resolve the effective control profile
3. send a bounded classification request to the Policy worker pool and receive a capability envelope
4. apply workflow and session-mode restrictions
5. combine profile policy, saved permissions, session permissions, and eligible SmartAllow decisions
6. deny, ask, or authorize the operation
7. apply the tool timeout
8. prepare an operating-system sandbox when the tool supports sandboxed execution
9. run plugin `before` hooks
10. execute the built-in, plugin, ephemeral, or MCP implementation
11. validate returned attachments and normalize the result
12. run plugin `after` hooks and settle the tool output

`ToolScheduler` keys a dispatch by session, session generation, message, call, executor class, and attempt. It deduplicates the same dispatch, bounds queued item count and serialized input bytes, applies global and per-executor concurrency, propagates cancellation, and never retries a running side-effecting call automatically. Executor classes are `local_process`, `file`, `plugin`, `mcp`, `browser`, `link`, and `control_plane`.

The scheduler is one logical execution layer, not one universal sandbox process. Local commands and command-backed search remain child processes with bounded output; installed plugin implementations reuse the plugin process runtime; MCP, Browser, and Link use their existing isolated transports or canonical runtimes. File operations and narrow operations that mutate canonical session/workflow state run asynchronously under scheduled Control Plane ownership. Classification changes admission and fault accounting, not authorization semantics.

The process boundary follows three ownership layers:

- the Control Plane owns HTTP/WebSocket service, sessions, durable state, authorization, scheduling, Browser session ownership, and plugin coordination;
- the elastic Agent worker pool owns provider inference and emits only projected model events and proposed tool calls;
- tool runtimes own physical execution through their existing process, child-process, MCP, Browser, Link, or Control Plane transports.

This split is a dependency boundary as well as an IPC boundary. The compiled executable first enters a dependency-free dynamic bootstrap, so worker subcommands do not evaluate the main CLI/server graph. The Agent worker runner's static import graph excludes Browser, Tool, Plugin, and Plugin Runtime implementations. Tool names, descriptions, and JSON Schemas cross into a worker; callbacks, Playwright/Chromium state, plugin processes, MCP clients, approval promises, and session writers do not. A model turn reaches its terminal provider result, disposes and releases the Agent worker, and only then can the Control Plane authorize and dispatch its proposed tools.

Memory recovery follows the same ownership boundary. The Control Plane decides Bun GC from its own RSS, heap, external, and ArrayBuffer measurements. Service-wide Linux cgroup charge and working set can throttle admission and drive diagnostics, but cannot by themselves trigger GC in the HTTP/WebSocket process because that collection cannot reclaim Agent or tool processes. Admission gates use the combined process and service classification independently from collection ownership. Agent workers apply their own post-turn collection and recycle policy. Tool runtimes release or terminate resources at their native process boundary.

Policy workers isolate capability analysis from the HTTP/WebSocket event loop. Their protocol carries only the tool name, JSON-like arguments, and immutable workspace/plugin classification context. It bounds request size, queue depth, aggregate queued bytes, per-request time, IPC frames, request count, RSS, and heap use. Global-runtime startup begins prewarming without making HTTP/WebSocket availability depend on the child process; the first classification waits up to the fixed ten-second handshake deadline before the shorter per-request queue/transfer/classification deadline begins. Repeated pre-ready exits use exponential backoff and open a finite startup circuit instead of entering a respawn loop. The Control Plane remains the sole owner of profile compilation results, approval state, audit state, sandbox accumulation, and the final allow/ask/deny decision.

Classification failure never re-enters the in-process top-level classifier. Worker startup timeout, request timeout, crash, protocol failure, queue rejection, or malformed input returns one opaque, non-bypassable `protected_op` capability and an immediate transient denial. Infrastructure failure cannot enter the approval system because the user cannot safely authorize an operation whose capabilities are unknown; this also keeps `guarded` and `full_access` from turning an ordinary runtime failure into execution. Cancellation remains cancellation rather than being converted into a policy result.

The enforcement gate owns the security decision. A tool implementation can still reject malformed input or fail for ordinary runtime reasons after authorization.

Tool exposure is a context-budget decision, not an authorization decision. `search_tools` and `expand_tools` let an eligible agent discover or activate deferred tools, but the resolver still removes every tool denied by agent, session, user-tool, or workflow policy.

## Capability Model

Classification describes what an operation can do, independently of which tool requested it. Capabilities cover file access, shell behavior, network access, browser control, session state, secrets, identity and messaging actions, plugin/platform operations, and other protected boundaries.

Risk is not inferred from a tool name alone. Shell commands are split and classified by their effective operations; one quote- and escape-aware longest-match lexer owns the compound operators `&&`, `||`, `|&`, `|`, `;;&`, `;;`, `;&`, `;`, and `&`. Redirect joins such as `2>&1` are not compound operators. Classification uses one shared time/depth/active-input budget, and no-progress, repeated, or over-depth analysis returns finite `shell` risk without restarting the top-level classifier. File paths are resolved against the current workspace and checked for external, protected, credential, VCS, and secret-like regions. Plugin tools declare capability envelopes in their manifests, and MCP calls pass through the same gate.

This separation lets one profile make consistent decisions across built-in tools, plugins, MCP servers, and future execution surfaces.

## Control Profiles

Synergy provides three standard profiles:

| Profile       | Intended use            | Approval behavior                                                       | Default sandbox                     |
| ------------- | ----------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `guarded`     | Interactive work        | Allows routine work and may ask for protected or higher-risk operations | Workspace-write, restricted network |
| `autonomous`  | Unattended work         | Never asks; operations outside policy are denied                        | Workspace-write, restricted network |
| `full_access` | Author-at-own-risk work | Silently authorizes every classified capability                         | No sandbox, full network            |

`full_access` bypasses Synergy's permission boundary; it does not suppress validation errors, missing files, operating-system failures, test failures, hooks, or network errors.

The effective profile is resolved in this order:

1. the closest explicit profile on the session or one of its parent sessions
2. the selected agent's profile
3. the top-level configured profile
4. the source default

Ordinary interactive sessions default to `guarded`. Root sessions created for Channels or Agenda default to `autonomous`. A delegated child therefore inherits an explicit profile from its parent chain unless it defines its own.

## Approval Sources

An authorization decision combines several sources without treating them as interchangeable:

- the control profile establishes the base policy
- persistent user rules can allow or deny matching actions across sessions
- session rules apply only to the current session and are held in memory
- one-time responses resolve a single pending request
- preauthorized session actions cover narrowly declared workflow operations
- SmartAllow can remove eligible false-positive asks or soft denials

Explicit denials and hard boundaries are not bypassed by preauthorization. Deny rules win over allow rules when both match.

In `guarded`, unresolved asks can be presented to the user. A response can authorize once, for the session, always, or reject. In `autonomous`, an ask is converted to a policy denial rather than waiting for a user who may never be present.

## SmartAllow

SmartAllow is a constrained policy assistant, not a second permission system. It runs only for eligible capabilities and must clear a confidence threshold. Interactive asks require at least `0.85`; eligible autonomous soft denials require at least `0.90`.

Hard boundaries are never eligible. When a decision involves a secret-like path, SmartAllow receives metadata or redacted evidence rather than raw secret values. Failures and circuit-breaker conditions fall back to the profile decision: `guarded` can still ask, while `autonomous` denies.

## Filesystem and Worktree Boundaries

The active workspace is the default write boundary. Ordinary files outside it may be read when they are not sensitive, including files in the original checkout of a worktree session. External writes, modifications, and execution remain protected.

In particular, an autonomous worktree session can inspect its original checkout but cannot write there or run commands from it. Approved external roots can be added to the execution sandbox for the authorized operation.

Configured skill roots and plugin skill roots are trusted runtime areas. Access inside those roots is not treated as an arbitrary external write or execution unless the requested path escapes the trusted root.

## Sandbox Enforcement

The permission gate decides whether an operation is authorized; the sandbox constrains the process after authorization. Its filesystem modes are:

- `none` — do not add an OS sandbox
- `read_only` — expose readable roots without workspace writes
- `workspace_write` — permit writes inside the workspace and approved writable roots

Network policy is represented separately as full or restricted access. Restricted sandboxes still support the local bindings and runtime channels explicitly required by the execution environment.

Synergy compiles the policy into platform-specific wrappers: Seatbelt on macOS, a Linux sandbox helper, and Windows/WSL-specific restricted execution paths. The configured fallback (`deny`, `warn`, or `allow`) determines what happens when the requested sandbox cannot be enforced on the current platform.

Stable Linux and Windows runtimes package an architecture- and ABI-matched helper. The runtime embeds that helper's SHA-256 during compilation and verifies it before execution; a Stable build fails when the required helper asset is absent. Linux uses either a verified optional bundled Bubblewrap binary or the system `bubblewrap` package. The Debian installer declares Bubblewrap as a dependency, while portable and CLI archive installations report it as an external prerequisite.

An explicit policy authorization can mark a shell operation as sandbox-bypassed. Otherwise, Bash receives the resolved sandbox wrapper when its profile mode is not `none`.

## OOM Victim Preference

On Linux, Synergy increases the chance that local Bash tool processes are selected before the core runtime during an out-of-memory kill.

- The systemd user service unit sets `OOMPolicy=continue`. When a child in the service cgroup is killed by the OOM killer, systemd does not automatically stop the remaining service processes; the kernel can still select the main process independently.
- After permission resolution, local Linux Bash prefixes the materialized command with a best-effort write of `1000` to `/proc/self/oom_score_adj` before sandbox preparation. This makes the tool child a preferred victim; the write is silent on failure and never blocks the command.

These are victim-preference hints, not hard memory limits or cgroup constraints. Remote Link Bash and non-Linux local Bash are unchanged.

Local child-process completion has a separate output-drain boundary. The parent exit event stops command timers, while stdout and stderr remain attached long enough to preserve finite tail output. Completion normally settles on the close event. If an untracked descendant inherits those pipes and keeps them open, the direct user shell and foreground Bash paths that do not authorize detached daemons terminate the owned process tree after a bounded one-second grace period before destroying local pipe handles and removing listeners and registry child/stdin references. Explicitly backgrounded or explicitly authorized detached Bash work remains under its existing runtime policy. A detached descendant therefore cannot keep a Bash tool or user shell request pending indefinitely.

## Session and Workflow Restrictions

Authorization is also constrained by the current session role. Plan is read-only with respect to project execution. Delegated subagents normally cannot re-delegate, operate the task graph, or ask permission questions. Internal reviewers can receive a deliberately configured delegation group without becoming user-selectable primary agents.

These restrictions are evaluated before the tool implementation. A permissive control profile does not make a tool visible to an agent or remove workflow-specific tool restrictions.

## Invariants

- Every executable tool path passes through the centralized enforcement gate.
- Model-facing tool definitions never contain executable callbacks.
- Agent worker static imports never reach Browser, Tool, Plugin, or Plugin Runtime implementations.
- The executable bootstrap has no static application imports and dynamically selects exactly one runtime entrypoint.
- Permission decisions remain in the Control Plane and occur only after the Agent worker has released its turn.
- Capability analysis runs in bounded Policy workers; those workers never decide authorization or execute tools.
- Policy worker failure produces a finite conservative denial, never opens an approval wait, and cannot block HTTP/WebSocket service.
- ToolTask queues are bounded globally and per executor class; duplicate dispatch identity cannot execute twice.
- Executor classification never bypasses capability classification, approval, sandboxing, or canonical runtime ownership.
- Availability, authorization, and sandboxing remain separate decisions.
- Expanding a deferred group never grants a tool whose effective permission is denied.
- `autonomous` never prompts the user.
- `full_access` authorizes capabilities but cannot turn runtime failure into success.
- Sensitive values are never sent raw to SmartAllow.
- Worktree isolation protects writes and execution outside the active worktree.
- A workflow or agent restriction can remove a tool even when the control profile would allow its capability.
