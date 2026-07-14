# Execution Boundaries

Synergy evaluates every tool call at a centralized execution boundary. Tool availability, capability classification, approval, sandboxing, plugins, and the tool implementation are distinct stages; no individual tool is allowed to invent a parallel permission model.

## Execution Pipeline

For each model turn, the session tool resolver collects ephemeral tools, built-in and plugin tools, and MCP tools. It filters that set by agent visibility and session exposure before wrapping each callable tool with the same runtime pipeline:

1. verify that the current execution context permits the tool
2. resolve the effective control profile
3. classify the requested operation into a capability envelope
4. apply workflow and session-mode restrictions
5. combine profile policy, saved permissions, session permissions, and eligible SmartAllow decisions
6. deny, ask, or authorize the operation
7. apply the tool timeout
8. prepare an operating-system sandbox when the tool supports sandboxed execution
9. run plugin `before` hooks
10. execute the built-in, plugin, ephemeral, or MCP implementation
11. validate returned attachments and normalize the result
12. run plugin `after` hooks and settle the tool output

The enforcement gate owns the security decision. A tool implementation can still reject malformed input or fail for ordinary runtime reasons after authorization.

## Capability Model

Classification describes what an operation can do, independently of which tool requested it. Capabilities cover file access, shell behavior, network access, browser control, session state, secrets, identity and messaging actions, plugin/platform operations, and other protected boundaries.

Risk is not inferred from a tool name alone. Shell commands are split and classified by their effective operations; file paths are resolved against the current workspace and checked for external, protected, credential, VCS, and secret-like regions. Plugin tools declare capability envelopes in their manifests, and MCP calls pass through the same gate.

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

Persisted orchestration definitions are not authorization sources. WorkflowRun creation freezes the Boss session's then-effective profile as an explicit durable cap, records the prior raw session profile, and every seat inherits the cap; a Charter cannot select `autonomous` or `full_access` to widen the permissions, filesystem roots, network policy, or sandbox of the session that created the run. Generic session profile updates are rejected while either a Boss or seat binding remains, so callers cannot bypass the frozen cap through another API. Cancellation conditionally removes only that run's Boss binding and restores the recorded raw profile, so the temporary cap does not leak into later ordinary conversation. Recovery performs the same binding/profile repair or cleanup atomically. This same-value snapshot is an orchestration fence, not a child-selected override. Any future broader child-profile override requires its own explicit high-risk authorization contract at execution time, not merely approval to write internal workflow state.

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

An explicit policy authorization can mark a shell operation as sandbox-bypassed. Otherwise, Bash receives the resolved sandbox wrapper when its profile mode is not `none`.

## Session and Workflow Restrictions

Authorization is also constrained by the current session role. Plan is read-only with respect to project execution. Delegated subagents normally cannot re-delegate, operate the task graph, or ask permission questions. Internal reviewers can receive a deliberately configured delegation group without becoming user-selectable primary agents.

These restrictions are evaluated before the tool implementation. A permissive control profile does not make a tool visible to an agent or remove workflow-specific tool restrictions.

## Invariants

- Every executable tool path passes through the centralized enforcement gate.
- Availability, authorization, and sandboxing remain separate decisions.
- `autonomous` never prompts the user.
- `full_access` authorizes capabilities but cannot turn runtime failure into success.
- Sensitive values are never sent raw to SmartAllow.
- Worktree isolation protects writes and execution outside the active worktree.
- A workflow or agent restriction can remove a tool even when the control profile would allow its capability.
- Persisted workflow, agent, or plugin data cannot elevate a child beyond the authority that launched it.
