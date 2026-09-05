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

Built-in/plugin and MCP execution race the combined session and tool-timeout abort signal across the complete `before` hook, implementation, and `after` hook lifecycle at the Resolver boundary. The same signal is propagated into plugin hook runtimes for physical cancellation. When that signal fires, the Resolver immediately settles the provider call as an error even if a hook or physical implementation ignores cancellation. A later physical return is ignored and cannot overwrite the terminal slot, start a not-yet-entered implementation, continue to another hook handler, or trigger an automatic retry; the underlying runtime remains responsible for stopping work already in progress and containing any side effects.

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

Tool exposure is a context-budget decision, not an authorization decision. `search_tools` and `expand_tools` let an eligible agent discover or activate deferred tools, but the resolver still removes every tool denied by agent, session, user-tool, or workflow policy. Deferred MCP server groups are discoverable through the "Connected MCP groups" directory in the `expand_tools` description whenever the MCP defer threshold is active; the directory lists connected servers and their tool names so an agent can expand `mcp:<server>` directly. A direct model call to a deferred-but-authorized tool is auto-expanded and executed in the same turn (the runtime equivalent of calling `expand_tools` for that tool); auto-expansion changes visibility only, never grants authorization, and is disabled when `expand_tools` itself is denied.

## Capability Model

Classification describes what an operation can do, independently of which tool requested it. Capabilities cover file access, shell behavior, network access, browser control, session state, secrets, identity and messaging actions, plugin/platform operations, and other protected boundaries.

Risk is not inferred from a tool name alone. Shell commands are split and classified by their effective operations; one quote- and escape-aware longest-match lexer owns the compound operators `&&`, `||`, `|&`, `|`, `;;&`, `;;`, `;&`, `;`, and `&`. Redirect joins such as `2>&1` are not compound operators. Classification uses one shared time/depth/active-input budget, and no-progress, repeated, or over-depth analysis returns finite `shell` risk without restarting the top-level classifier. File paths in a non-pipeline compound command are classified from the risk of the segment that references them: a read-only inspection such as `file <path>` remains a read when a separate path-free segment keeps the aggregate shell risk conservative, while interpreter, mutation, and `file --compile` segments classify their referenced paths as write-capable. Pipelines and command-directory state changes aggregate path risk across dependent segments. File paths are resolved against the active workspace and approved roots before profile policy is applied. Plugin tools declare capability envelopes in their manifests, and MCP calls pass through the same gate.

Shell word tokenization tracks `$()` and backtick nesting so an assignment prefix such as `files=$(find "$d" ...)` stays one word instead of misreading a quoted fragment as a dynamic command name. find/fd command-execution forms (`-exec`, `-execdir`, `-x`, `-X`, `--exec`, `--exec-batch`) inspect the executed utility against a closed read-only whitelist; mutating utilities, interpreters, network tools, and unknown utilities keep the command destructive, and `-delete` / `-ok` / `-okdir` remain destructive unconditionally. Exec-target inspection unwraps shell re-parse payloads (`sh -c`, `eval`, `trap`, function bodies, multicall applets, and directory wrapper payloads) before rescanning, so quoted destructive find/fd executions are not hidden by quote masking. Absolute-path extraction rejects awk/sed regex and pattern literals (bare `/`, `/^...`, and candidates containing backslash, backtick, or `$`) so pattern text is never classified as an external file path.

Unquoted physical newlines are classified as shell-list boundaries equivalent to `;`. Escaped or quoted newlines remain inside their current segment, and a heredoc header, body, and delimiter remain one segment so heredoc data is not reinterpreted as top-level commands.

Absolute-path candidates terminate at closing shell punctuation (`)`, `}`), and null-device sinks (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`) are never filesystem paths — including when a redirect such as `2>/dev/null` is glued to a closing paren/brace inside a subshell or loop body (`2>/dev/null)`). A statically resolvable write-redirect target (`>`, `>>`, `>|`, `&>`, `&>>`, `N>`, `<>`) is a genuine write even when the rest of the segment classifies read-only (for example `git status > /tmp/out`); dynamic targets (`$var`, backtick) are left to the execution sandbox boundary when one is active.

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

## Live Profile Transitions

A user can change the effective control profile of an active session without stopping execution. The agent cannot escalate its own privileges.

### User-initiated transition

The frontend keeps the permission-mode selector available while the session is running. A PATCH request to `/session/:sessionID` with `controlProfile: "full_access"` and `resolvePendingPermissions: true` performs an ordered transition:

1. The explicit `full_access` profile is persisted on the session before any other side effect.
2. All inheriting descendant sessions are identified — sessions whose effective profile resolves through the target session because they have no explicit profile of their own.
3. Eligible pending permission asks for the target session and its inheriting descendants are resolved with `once` semantics (one-time approval of the specific operation). This does not create persistent user or session permission rules.
4. Hard denials and Policy Worker infrastructure failures never enter the pending approval flow and remain denials. As defense in depth, any pending request marked non-bypassable is not auto-resolved.

### Agent-facing tool remains idle-only

The `session_control.set_control_profile` tool used by agents still requires an idle session (`SessionManager.assertIdle`). A running agent cannot self-escalate or trigger pending-ask resolution.

### Behavior boundaries

- In-flight tool execution already admitted under the previous control profile continues unchanged. Later permission decisions see the new profile.
- `full_access` authorizes every classified capability encountered from the transition point onward, but it does not retroactively convert validation errors, missing files, operating-system failures, test failures, hooks, or network errors into success.
- Pending-ask resolution covers only the target session and descendant sessions that inherit its profile. Sessions with their own explicit profile override are not affected.

## SmartAllow

SmartAllow is a constrained policy assistant, not a second permission system. It runs only for eligible capabilities and must clear a confidence threshold. Interactive asks require at least `0.85`; eligible autonomous soft denials require at least `0.90`.

Hard boundaries are never eligible. When a decision involves a secret-like path, SmartAllow receives metadata or redacted evidence rather than raw secret values. Failures and circuit-breaker conditions fall back to the profile decision: `guarded` can still ask, while `autonomous` denies.

## Filesystem and Worktree Boundaries

The active workspace is the default write boundary. Ordinary files outside it may be read when they are not sensitive, including files in the original checkout of a worktree session and durable Asset paths referenced by attachments. External writes, modifications, and execution remain protected. Read-only shell utilities such as `cat` and ordinary `file` inspection retain read access for the paths they inspect; adding a separate path-free segment does not upgrade those inspected paths to writes, while write-capable flags remain protected.

Copy-family commands (`cp`, `install`, `ln`) resolve operand roles when the segment is a plain, statically resolvable invocation: the final positional operand — or the `-t`/`--target-directory` value — is the write target and is classified explicitly, and every other operand classifies as a read-only source (including sensitive-path read checks). Identical source and destination strings keep the destination's write role. `mv` keeps all-write classification because it deletes its sources, and hard-link creation (`ln` without `-s`/`--symbolic`, `cp -l`/`--link`) keeps all-write classification because a hard link mutates the source inode and lets later writes pierce the external file. The role resolution is closed-world: pipelines, directory changes, shell-state reuse, wrappers, command substitution, glob or expansion syntax in any operand, quoted or escaped operands, redirections, and unrecognized flags fall back to the conservative all-write classification.

Command-directory changes use the same quote- and escape-aware parsing owner as shell risk classification. A write-capable command aggregates path risk across pipelines and effective directory changes from `cd`, directory-stack builtins, `env -C` / `--chdir`, shell or `eval` payloads, command substitutions, and control structures. Statically resolved targets are classified against the effective Bash working directory; dynamic, stack-dependent, nested, or otherwise unresolved changes produce a conservative opaque external-write denial. An explicit external Bash `workdir` is likewise treated as a write target whenever the command can write or execute derived content. The recursive directory analyzer covers `cd`, `pushd`, `popd`, `env -C` / `--chdir` / `-S`, shell `-c` payloads (including absolute executable paths, ANSI-C-quoted payloads, clustered flags, and multicall shell applets), `eval`, `trap`, quote-concatenated or dynamic command names, `$()` and legacy backtick command substitutions, Bash `<(...)` / `>(...)` process substitutions, inline language-runtime evaluation payloads, wrapper commands such as `exec`, `nice`, `nohup`, `script`, `setsid`, `stdbuf`, `sudo`, `time`, `timeout`, `watch`, and `xargs` (including replacement-token path flow). It also covers direct command execution through `su`, `sg`, `runuser`, `pkexec`, `nsenter`, and Docker/Podman `exec`, `run`, or `create` payloads. Comment-only fragments and inert strings do not become executable directory state. Directory analysis shares the classification deadline, input-size limit, recursion depth, and active-input cycle guard. Exhausting any bound returns an opaque result rather than restarting analysis. Wrapper options that change the effective directory remain part of the aggregate path decision: `sudo -D` / `--chdir` contributes its directory target, and `command` prefixes skip `-p`, `-P`, `-v`, `-V`, and `--path` before resolving wrapped commands such as `env -C`. A write-capable compound command that reuses path-bearing special shell state such as `$_` across segments also produces opaque external-write risk. Shell-state reuse is traced through command and process substitutions and shell re-parse boundaries such as `eval` and signal-bearing deferred `trap` handlers, including Bash parameter-operator forms derived from `$_` such as `${_:0}` and `${_#prefix}`; unresolved or budget-exhausted analysis remains conservative. Destructive `sudo` classification resolves quote-concatenated, escaped, and empty-substitution command spellings through the shared shell parser, then recursively inspects command and process substitutions, shell `-c` and long `--command` payloads, executable heredoc and herestring stdin (including separated redirect operands and `/dev/stdin`), valid function-definition bodies, inline language-runtime execution APIs, wrapper payloads, and indirect executors. Lookup-only `command -v` / `-V` forms remain inert, while `command --path` consumes its value before the wrapped command is classified.

Slash-containing relative cd targets (e.g. `cd packages/synergy/src`) resolve against the current working directory when the command text does not define CDPATH, matching the execution environment allowlist that never carries a parent CDPATH; bare-name targets, dynamic (`$` or backtick) targets, and commands that assign or export CDPATH stay opaque.

Shell continuation and stdin data-flow analysis follow actual execution semantics. Escaped newlines are joined before command-name normalization. Interpreter stdin redirects recognize attached or separated descriptor-zero forms such as `sh 0< file`; glued heredoc and herestring descriptors are preserved, while a separated IO number such as `exec 3 <<< ...` remains an ordinary argument. Interpreter wrappers preserve the same source selection. The classifier follows heredoc and herestring bodies replayed through a named descriptor, including fd-copy chains such as `exec 3<<'EOF' … exec 4<&3 … sh <&4`; regular files opened with `exec N< file` and later consumed through `<&N`; descriptor zero inherited by a later stdin-code interpreter; heredoc bodies written to a file and later executed; and process substitutions whose output becomes interpreter input. Data consumers that only print or copy the same text remain non-executing. Inline runtime analysis recursively inspects executable string arguments for process-spawning APIs, including Python `check_call`, `check_output`, `getoutput`, and `getstatusoutput` plus equivalent spawn variants, without treating display-only strings as execution.

Process-substitution payloads are always recursively inspected for executable commands. Their emitted output is treated as interpreter code when the substitution occupies an interpreter's code-file option or positional, or when `<` redirects it into interpreter stdin. With an explicit stdin placeholder, another process-substitution positional is ordinary data unless the substitution supplies redirected stdin, as in `python3 - < <(...)`. Herestring replay recognizes optional whitespace after `<<<` and quote-concatenated payload words. A definite descriptor-0 `exec` command suppresses later replay only while Bash `execfail` is known disabled. `set -o execfail` is inert because `execfail` is a `shopt` option; direct and `eval`-reparsed `shopt` mutations are tracked, while traps, function bodies, sourced code, and other unresolved mutations remain conservative. Inline interpreter string decoding covers hexadecimal `\xNN`, octal `\NNN`, Python `\UNNNNNNNN`, and brace Unicode `\u{...}` escapes. A non-raw Python Unicode-name escape such as `\N{...}` in an executable string is opaque rather than partially decoded; literal double-backslash sequences remain inert until a shell re-parse boundary decodes them.

Interpreter option parsing distinguishes configuration values from executable inputs. Python `-W` / `-X` / `--check-hash-based-pycs` and Bash `-O` / `+O` / `-o` / `+o` consume configuration values before positional analysis. Node `-r` / `--require` designates a code-bearing file. Bash `--rcfile` / `--init-file` always consumes its value but executes that startup file only in interactive mode (`-i`), so interactive targets are recursively inspected while non-interactive values remain inert. Separated and `--option=value` forms are supported, and `--` ends option parsing. An `exec` herestring is also checked against the interpreter invoked in that same segment, including valid clustered `-a` / `-c` / `-l` forms and named-descriptor `<&N` consumption.

Environment wrappers preserve assignments both before and after `env`'s `--` option terminator and expand `-S` / `--split-string` before locating the wrapped executable. Inherited `BASHOPTS=execfail` therefore participates in failed-`exec` replay analysis through direct assignment, plain `env`, `env --`, and split-string forms. Interactive shell invocation (`-i` in the option region) always keeps running after a failed `exec`, so replay analysis applies there without requiring `execfail`; options are scanned only up to the first `-c` / `--command` / `--`, and the attached `-Oexecfail` spelling is treated conservatively for version portability. Lookup-only `command -v` / `-V` forms remain inert, `builtin` unwraps only real shell builtins, and transparent wrappers (`exec`, `nice`, `nohup`, `setsid`, `stdbuf`, `time`, `timeout`, `watch`, `xargs`, `busybox` / `toybox` applets, and the macOS/BSD `script file command ...` positional form) forward `bash -O execfail` unchanged; redirects preceding an `exec` command are skipped, while heredoc bodies remain data. An assignment-looking word after such a wrapper is the wrapper's command name, not an environment assignment. Numeric file descriptors are canonicalized before redirect and replay alias tracking, so spellings such as `03` and `3` identify the same descriptor.

For shell interpreters, `-s` selects stdin as the code source; Python-style `-` placeholders do the same for their runtimes. With an explicit `-` or `-s` placeholder and no stdin redirect, a process substitution supplied as another positional remains ordinary data. Without that placeholder, a process substitution in the interpreter's code-file positional is executable. An explicit `<` or `0<` redirect from a generated file or process substitution is executable stdin and participates in destructive payload classification even when the placeholder is present. Function-definition bodies are treated as opaque because they can defer or disguise equivalent directory changes behind builtins, `eval`, shell payloads, or dynamic command names. Bare-name `cd` and `pushd` targets without a `/`, `~`, or `.` prefix are also opaque because `CDPATH` can redirect them outside the apparent working directory; explicit relative, absolute, and tilde-prefixed targets remain statically resolved. Unquoted ANSI-C `$'...'` words that contain escapes are conservatively opaque because Bash can decode command names, shell payloads, or directory targets after lexical inspection. Escaped ANSI-C text inside a quoted argument is also opaque when it reaches a shell `-c`, `eval`, `trap`, or `env -S` / `--split-string` re-parse boundary; ordinary quoted display text remains inert. Function definitions preceded by control-flow keywords and directory-capable commands hidden in `case ... in` arms are likewise opaque rather than partially parsed. Shell payload detection covers executable basenames ending in `sh` plus `fish`, `nu`, `rc`, and `es`, including absolute paths, clustered or attached `-c` flags, long `--command` forms where supported, and `busybox` / `toybox` shell applets; network clients such as `ssh` and `mosh` are excluded from this shell-engine rule. Inline-code receivers are conservatively opaque for Python and PyPy `-c`, Node-compatible and language-runtime evaluation flags, PHP inline processing flags, PowerShell command or encoded-command flags, `deno eval`, and AWK `system()` payloads. Sudo-sensitive inline API inspection recognizes executable calls rather than display-only strings and joins adjacent string literals before checking the invoked command. BSD positional and GNU `--command` forms of `script` are inspected. Docker/Podman `run` and `create` apply last-option-wins `--entrypoint` semantics, including explicit clearing; `exec` does not treat that option as valid, and unknown separated container options fail closed rather than exposing an unchecked payload.

An in-command CDPATH assignment or export likewise keeps slash-containing relative cd targets opaque, so only commands with no CDPATH definition of their own get the static cwd-relative resolution.

A project Scope can declare multiple project folders (its main worktree plus additional folders persisted in `scope.sandboxes`). Every declared project folder is a trusted write root for the session's control profile, sandbox policy, and file-tool containment checks — reads and writes inside any project folder behave like the active workspace and do not require per-path approval. The canonical derivation is `Scope.Root.projectRoots` / `trustRoots` / `executionRoots`; gate creation sites must consume `executionRoots` rather than reconstructing one directory.

In a `git_worktree` session the original main checkout is excluded from the project trust roots and stays outside the trust boundary. An autonomous worktree session can inspect its original checkout but cannot write there or run commands from it. Approved external roots can be added to the execution sandbox for the authorized operation. Sibling worktrees declared as project folders are trusted — only the original checkout remains external.

Configured skill roots and plugin skill roots are trusted runtime areas. Access inside those roots is not treated as an arbitrary external write or execution unless the requested path escapes the trusted root. Read roots grant only read access; they never authorize modifying or executing an attachment or other external file.

## Sandbox Enforcement

The permission gate decides whether an operation is authorized; the sandbox constrains the process after authorization. Its filesystem modes are:

- `none` — do not add an OS sandbox
- `read_only` — expose readable roots without workspace writes
- `workspace_write` — permit writes inside the workspace and approved writable roots

Network policy is represented separately as full or restricted access. Restricted sandboxes still support the local bindings and runtime channels explicitly required by the execution environment.

Synergy compiles the policy into platform-specific wrappers: Seatbelt on macOS, a Linux sandbox helper, and Windows/WSL-specific restricted execution paths. The configured fallback (`deny`, `warn`, or `allow`) determines what happens when the requested sandbox cannot be enforced on the current platform. The macOS deny-default Seatbelt profile imports Apple's `system.sb` before applying scoped read/write roots: probes on current macOS releases show a hand-rolled deny-default profile aborts every child (SIGABRT) without it, while the import keeps processes viable and scoped allows/denies effective.

Stable Linux and Windows runtimes package an architecture- and ABI-matched helper. The runtime embeds that helper's SHA-256 during compilation and verifies it before execution; a Stable build fails when the required helper asset is absent. Linux uses either a verified optional bundled Bubblewrap binary or the system `bubblewrap` package. The Debian installer declares Bubblewrap as a dependency. When the interactive CLI installer detects `apt-get`, `dnf`, or `pacman`, it offers to install a missing package after explicit confirmation; non-interactive runs, declined or failed installation, unsupported package managers, and portable archives leave Bubblewrap as an external prerequisite.

An explicit policy authorization can mark a shell operation as sandbox-bypassed. Otherwise, Bash receives the resolved sandbox wrapper when its profile mode is not `none`. Profile auto-allow under `autonomous` never bypasses the sandbox: unattended profile-permitted Bash runs inside the `workspace_write` wrapper so writes that static classification cannot see (variable redirect targets such as `out=/tmp/…`) are contained at execution time instead of landing on the host. `guarded` user-rule/SmartAllow/approved operations and `full_access` keep the historical bypass behavior. The sandbox wrapper forwards the gate's approved readable roots so gate-allowed external reads execute inside the sandbox; the Linux full-network profile read-only binds /etc (plus resolv.conf and systemd-resolve paths when present); and the session key scopes the controlled temp root so concurrent sessions cannot see each other's sandbox temp files.

The `autonomous` profile's writable roots include a controlled temporary root at `<workspace>/.synergy/tmp` (session-scoped as `synergy-<pid>-<session>` when a session key is available), reusing the Linux controlled-tmp precedent. Sandboxed Bash points `TMPDIR`/`TMP`/`TEMP` at that root, so tools that honor `TMPDIR` write inside the workspace boundary; literal writes to the root classify as ordinary workspace `file_write`, while the host's shared temporary directory remains an external write. Because `autonomous` never prompts, its sandbox fallback defaults to `deny` (fail-closed): when the OS sandbox cannot be prepared, the operation is refused rather than run unsandboxed. Operators can override through `sandbox.fallbackPolicy`, `sandbox.enabled=false`, or switching to `guarded`/`full_access`; `guarded` keeps `warn`.

The sandbox network mode follows the gate-approved network capability: when the gate approves a network command (`git fetch`, `curl`, `npm install`) the compiled profile uses full networking, otherwise it stays restricted; macOS full networking pairs `(allow network*)` with system.sb's `(system-network)` helper so DNS/SystemConfiguration lookups resolve under `(deny default)`. macOS profiles read the developer toolchain roots (`/opt/homebrew`, `/usr/local`, the Command Line Tools, `/etc`/`/private/etc`) and skip sibling denies for explicitly allowed user runtime read roots (`~/.gitconfig`, `~/.config/git`, `~/.bun`), so git and language toolchains do not fatal-error in-sandbox. Writable-root `.git` protection is granular: only `.git/hooks` and `.git/config` stay read-only, leaving objects/refs/HEAD/index writable so `git commit`/`git branch` keep working while the tamper/code-execution surface remains protected; `.agents`/`.codex` stay blanket-protected.

## OOM Victim Preference

On Linux, Synergy increases the chance that local Bash tool processes are selected before the core runtime during an out-of-memory kill.

- The systemd user service unit sets `OOMPolicy=continue`. When a child in the service cgroup is killed by the OOM killer, systemd does not automatically stop the remaining service processes; the kernel can still select the main process independently.
- After permission resolution, local Linux Bash prefixes the materialized command with a best-effort write of `1000` to `/proc/self/oom_score_adj` before sandbox preparation. This makes the tool child a preferred victim; the write is silent on failure and never blocks the command.

These are victim-preference hints, not hard memory limits or cgroup constraints. Remote Link Bash and non-Linux local Bash are unchanged.

Local child-process completion has a separate output-drain boundary. The parent exit event stops command timers, while stdout and stderr remain attached long enough to preserve finite tail output. Completion normally settles on the close event. If an untracked descendant inherits those pipes and keeps them open, the direct user shell and foreground Bash paths that do not authorize detached daemons wait a bounded one-second grace period, then terminate their owned process boundary before destroying local pipe handles and settling. On Unix, Synergy wraps the command with a short-lived sentinel that preserves the owned process-group identity after the direct shell exits; cleanup signals only that process group and does not claim descendants that create a new session or process group. On Windows, Synergy owns the command tree with a kill-on-close Job Object; termination falls back to closing the retained owner handle, and a close failure preserves the owner for retry. Authorized Windows detached daemons are rejected while an active sandbox Job would still own them; operators must use `full_access` or an explicitly policy-approved sandbox bypass.

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
- Expanding a deferred group never grants a tool whose effective permission is denied; auto-expansion on a direct tool call is equally visibility-only and respects the `expand_tools` permission.
- `autonomous` never prompts the user.
- Write-redirect targets classify by the write they perform, not the read risk of the surrounding command; null-device sinks never classify as paths.
- `full_access` authorizes capabilities but cannot turn runtime failure into success.
- Sensitive values are never sent raw to SmartAllow.
- Worktree isolation protects writes and execution outside the active worktree.
- A workflow or agent restriction can remove a tool even when the control profile would allow its capability.
