# Execution Boundaries

Synergy evaluates every tool call at a centralized Control Plane execution boundary. Tool availability, model presentation, capability classification, approval, scheduling, sandboxing, physical execution, and result settlement are distinct stages; no individual tool is allowed to invent a parallel permission model.

The harness owns permission policy and the `SandboxHost` wrapper contract. The local runtime owns OS sandbox implementations and helpers, native PTYs, process containment and file watchers. Local composition registers these before execution; a bare harness neither imports their native dependencies nor starts a file watcher. A sandboxed operation without a registered host fails explicitly.

## Execution Pipeline

For each model turn, the session tool resolver collects ephemeral tools, built-in and plugin tools, and MCP tools. Workspace capability is checked before exposure and again at execution: a session with a null workspace cannot invoke filesystem tools, even through a retained tool handle or `full_access`. This is a capability requirement independent of permission approval. Plugin and MCP tools require a workspace by default; the owning declaration may explicitly set `requiresWorkspace: false` for directory-independent operations. It filters that set by agent visibility and session exposure, then emits two separate products:

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

Classification failure never re-enters the in-process top-level classifier. Worker startup timeout, request timeout, crash, protocol failure, queue rejection, or malformed input returns one opaque, non-bypassable `protected_op` capability. Under `guarded` and `autonomous` that capability produces an immediate transient denial. Under `full_access` the operation proceeds instead: the profile already authorizes every classified capability, so the classifier's labels are not what stops anything there, and failing closed would let an unrelated infrastructure fault refuse work the user explicitly pre-authorized. The opaque capability, the gate audit record, and the `enforcement.policy.fallback` metric remain the evidence trail for that fail-open path. Infrastructure failure never enters the approval system under any profile, because the user cannot safely authorize an operation whose capabilities are unknown. Cancellation remains cancellation rather than being converted into a policy result.

The enforcement gate owns the security decision. A tool implementation can still reject malformed input or fail for ordinary runtime reasons after authorization.

Tool exposure is a context-budget decision, not an authorization decision. `search_tools` and `expand_tools` let an eligible agent discover or activate deferred tools, but the resolver still removes every tool denied by agent, session, user-tool, or workflow policy. Deferred MCP server groups are discoverable through the "Connected MCP groups" directory in the `expand_tools` description whenever the MCP defer threshold is active; the directory lists connected servers and their tool names so an agent can expand `mcp:<server>` directly. A direct model call to a deferred-but-authorized tool is auto-expanded and executed in the same turn (the runtime equivalent of calling `expand_tools` for that tool); auto-expansion changes visibility only, never grants authorization, and is disabled when `expand_tools` itself is denied.

## Secret Masking

The secret vault is a data-flow mechanism orthogonal to the control profiles: the gate answers "may this operation run", the vault answers "what value does this operation receive". The same masking applies under `guarded`, `autonomous`, and `full_access`, because its threat model is the model context, not the permission decision.

Registered values are held in a 0600 file-store beside the provider auth store (`Global.Path.secretVault`) with atomic writes, cross-process file locks, and corrupt-store quarantine. Entry ids derive deterministically from the value's SHA-256, so the same secret always masks to the same `⟦sec:<id>⟧` token — across processes, store recreations, and re-registrations.

Masking runs at three ingress owners:

1. User-message materialization masks text parts before durable persistence, so the session record holds tokens for detected or registered values.
2. Tool-result settlement masks the settled result immediately after execution and BEFORE rollout capture, in both the builtin and MCP paths — plugin after-hooks, rollout artifacts, and durable tool parts see tokens only.
3. `LLM.stream` masks the per-turn projection and late-system strings as a safety net covering every projection call site, including compaction, title, and summary calls.

Resolution runs inside the Control Plane execution window only. In both settlement paths the pinned order is: plugin `tool.execute.before` (tokens only) → `SecretResolve.transformArgs` (execution-only args copy) → execute → `SecretMask.transformResult` → `RolloutTool.capture`. Early tool-wrapper evidence capture also masks before persistence, and running progress metadata is masked inside the serialized part-update queue. Raw process-stream bytes and arbitrary binary attachments remain byte-preserving execution evidence outside this text-masking contract. Local bash receives values through `SYNERGY_SEC_*` environment injection so plaintext never appears in argv; a token embedded in a longer word, and any token on remote bash, degrades to literal substitution — the documented residual exposure. Policy denial substitutes a visible `⟦sec:<id>:DENIED⟧` marker and the run proceeds; a removed entry leaves the token literal, matching what the model saw.

The `/secrets` read endpoints return metadata only, and value reveal is a local CLI operation (`synergy secrets reveal`). This mirrors the config-export posture that keeps plaintext exports CLI-only because loopback-wide CORS would let any local page read them. The Settings panel manages the full lifecycle — register, rotate, per-key policy, resolve history, revoking remove — without displaying values.

The mechanism honestly does not bound executor-side exfiltration: after resolution, a pipeline that reads a file into a network command can still carry the plaintext out. Per-key policy (tool allowlist, per-session resolve cap) and the resolve audit trail bound but cannot prevent that; the resolve history is visible per key in the panel. Heuristic capture uses the versioned regex detector from the [secret-detection package](../../packages/secret-detection/README.md). The Harness detector source permits explicit replacement during runtime composition. It validates original-text spans and requires a complete result within five seconds; failed detection or registration stops capture. Unknown formats can pass through, and benign example keys can be masked. Exact matching of registered values remains independent of detection results. Capture batches missing values and reuses one Vault snapshot, matching longer values first. Detector-only and isolated capture benchmarks report quality and timing separately; see the [detector decision](../decisions/implemented/architecture/2026-09-20-replaceable-secret-detection.md).

## Capability Model

Classification describes what an operation can do, independently of which tool requested it. Capabilities cover file access, shell behavior, network access, browser control, session state, secrets, identity and messaging actions, plugin/platform operations, and other protected boundaries.

Risk is not inferred from a tool name alone. Each capability class has exactly one execution-time owner. Precise-input capabilities — the literal path arguments of structured tools (`write`, `edit`, `read`, `view_file`, `scan_files`, and their peers) — belong to the policy layer, which resolves them against the workspace and approved roots before profile policy applies. Imprecise-input capabilities belong to the execution layer: a shell command string is this repository's only imprecise input, so bash contributes only the capabilities the OS sandbox cannot express, and every filesystem decision inside a shell command is settled by the sandbox from the real syscall. Neither layer predicts the other's answer.

Shell commands are split and classified by their effective operations; one quote- and escape-aware longest-match lexer owns the compound operators `&&`, `||`, `|&`, `|`, `;;&`, `;;`, `;&`, `;`, and `&`. Redirect joins such as `2>&1` are not compound operators. Classification uses one shared time/depth/active-input budget, and no-progress, repeated, or over-depth analysis returns finite `shell` risk without restarting the top-level classifier. Bash mints no `file_*` capability at all: its `workdir` argument, redirect targets, absolute paths, and directory changes are all sandbox-owned. Plugin tools declare capability envelopes in their manifests, and MCP calls pass through the same gate.

There is no read-only shell tier. A command whose only reach is the filesystem sits at the risk floor (`shell`, an ordinary capability) and its containment is the sandbox's decision; the classifier refuses only what the sandbox cannot express. This is why `shell_read` no longer exists as a capability: with no precise input to reason about, a read-only classification could only ever be a prediction about argument text.

Shell word tokenization tracks `$()` and backtick nesting so an assignment prefix such as `files=$(find "$d" ...)` stays one word instead of misreading a quoted fragment as a dynamic command name. The same traversal unwraps shell re-parse payloads (`sh -c`, `eval`, `trap`, function bodies, multicall applets, and directory wrapper payloads) for the surviving detectors, so a quoted payload cannot hide privilege escalation, remote mutation, or irreversible destruction from them.

`find -delete`, `find -exec`, and in-workspace subtree removal (`rm -rf node_modules`, `rm -r ./build`) are filesystem-only shapes, so they are owned by the sandbox: allowed inside the workspace and refused with an operating-system error outside it. The gate no longer inspects the executed utility, and it adds no per-shape whitelist to catch residual cases.

Unquoted physical newlines are classified as shell-list boundaries equivalent to `;`. Escaped or quoted newlines remain inside their current segment, and a heredoc header, body, and delimiter remain one segment so heredoc data is not reinterpreted as top-level commands.

Because bash predicts no path, the sink and redirect spellings that used to need careful static treatment (`2>/dev/null`, `2>/dev/null)` glued to a closing brace, `git status > /tmp/out`) carry no classification consequence: none of them emits a capability, and the sandbox sees the real descriptor.

One tokenizing owner decides every shell risk the OS sandbox cannot express; no substring or lowercased pattern scan participates. Host-level destruction is decided from operands: an `rm` targeting the filesystem root, the home directory, or a wildcard form of either is a machine-wide hardline rule, as are the filesystem and power tools (`mkfs.*`, `fdisk`, `parted`, `lvremove`, `pvremove`, `vgremove`, `shutdown`, `reboot`, `halt`, `poweroff`) except their read-only and help forms, so `fdisk -l`, `parted --list`, `mkfs -h`, and `shutdown --help` stay executable while `fdisk /dev/sda` and `shutdown -h now` do not. Irreversible secure deletion or truncation of a system location, and privilege escalation through `sudo` or an equivalent indirect executor, classify as destructive. Remote irreversibility follows the destination branch rather than the flag spelling: a force or delete against a protected branch (`main`, `master`, `dev`, `develop`, `trunk`) is a remote write, while the same operation against an explicitly named non-protected branch is remote publish because the loss is bounded by that branch's own commits; `--force-with-lease` and `--force-if-includes` are not destructive in themselves, an unbounded destination set (`--all`, `--tags`, `--mirror`, or a repository-selecting flag) stays a remote write, and a bare `git push --force` stays a remote write because `push.default` resolves its destination only at runtime. Irreversible local history (`reset --hard`, `clean -fdx`, `stash drop`, `stash clear`, `checkout -- <path>`, `filter-branch`, `filter-repo`, `reflog expire|delete`) stays destructive, while reflog- or worktree-recoverable operations — `rebase` including `--abort`/`--continue`, `reset --soft`/`--mixed`, `stash pop`, `commit --amend`, `revert`, `pull --rebase`, and `git rm` — do not; `git clean -f`/`-fd` removes only untracked files and is not destructive, while removing ignored files (`-x`) is. Whole-current-directory spellings (`.`, `./`, `./*`, `..`, and `*`) remain conservative hardline targets even inside a workspace. Host-level targets are decided before a path's containment is considered, so `rm -rf /` remains a hardline rule while `rm -rf <workspace subtree>` is an ordinary write the sandbox contains.

Network activity is likewise decided from the resolved operation rather than from command text: a closed set of network clients, the git and OpenSSL subcommands that contact a remote, package-manager subcommands that reach a registry, and an `rsync` operand carrying a remote host. Wrappers, shell and interpreter re-parse payloads, and command substitutions are unwrapped, and `/dev/tcp` and `/dev/udp` are matched on unquoted executable text because they function only as redirect targets. Argument text that merely names a tool or contains a URL — `echo "see https://example.com"`, `rg -n "ssh " docs/`, `git commit -m "fix npm install docs"` — is not network activity, which matters beyond reporting accuracy because an allowed `network_request` also relaxes the sandbox network mode to full. Budget or depth exhaustion reports the capability rather than assuming an inert command.

This separation lets one profile make consistent decisions across built-in tools, plugins, MCP servers, and future execution surfaces.

## Control Profiles

Synergy provides three standard profiles:

| Profile       | Intended use            | Approval behavior                                                       | Default sandbox                     |
| ------------- | ----------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `guarded`     | Interactive work        | Asks the user for protected or higher-risk operations                   | Workspace-write, restricted network |
| `autonomous`  | Unattended work         | Never asks; operations outside policy are denied                        | Workspace-write, restricted network |
| `full_access` | Author-at-own-risk work | Never asks and allows everything, including non-bypassable capabilities | No sandbox, full network            |

The three profiles differ on exactly two axes: whether the user is asked, and whether anything is refused. `guarded` asks. `autonomous` never asks and refuses instead. `full_access` never asks and allows, so no Synergy-internal condition produces a permission denial under it — not a hard boundary, not a non-bypassable capability, and not a classification-infrastructure failure.

`full_access` bypasses Synergy's permission boundary; it does not suppress validation errors, missing files, operating-system failures, test failures, hooks, or network errors.

Because enabling `full_access` is the point where the user stops being asked, the UI shows a one-time confirmation that then records `fullAccessAcknowledged`. That key is an awareness record, not a security boundary: it does not gate the HTTP API or a hand-edited config file, and it never applies to programmatic session creation. Re-selecting the mode already in force does not re-prompt.

The effective profile is resolved in this order:

1. the closest explicit profile on the session or one of its parent sessions
2. the selected agent's profile
3. the top-level configured profile, for any session whose source can answer an ask
4. for a non-interactive root, the configured `nonInteractiveControlProfile`
5. the source default

Ordinary interactive sessions default to `guarded`. Root sessions created for Channels or Agenda — the sources with no human available to answer a prompt — take the configured `nonInteractiveControlProfile`, whose default is `autonomous`. A top-level profile that can answer for itself still applies to those roots, so an operator who set `full_access` or `autonomous` keeps it; a top-level `guarded` does not apply there, because an ask raised with nobody attached would pend forever. `guarded` is likewise not selectable for the non-interactive key. A delegated child inherits an explicit profile from its parent chain unless it defines its own.

The configured non-interactive profile governs sessions created after the change. An already-created session keeps the profile persisted on it, because an operator changing the setting must not retroactively re-permission a task that is already running.

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
4. Hard denials and Policy Worker infrastructure failures never enter the pending approval flow. Under `guarded` and `autonomous` they remain denials; under `full_access` neither can deny at all, because the profile authorizes non-bypassable capabilities and does not fail closed on classification failure. As defense in depth, any pending request marked non-bypassable is not auto-resolved.

### Agent-facing tool remains idle-only

The `session_control.set_control_profile` tool used by agents still requires an idle session (`SessionManager.assertIdle`). A running agent cannot self-escalate or trigger pending-ask resolution.

### Behavior boundaries

- In-flight tool execution already admitted under the previous control profile continues unchanged. Later permission decisions see the new profile.
- `full_access` authorizes every classified capability encountered from the transition point onward, but it does not retroactively convert validation errors, missing files, operating-system failures, test failures, hooks, or network errors into success.
- Enabling `full_access` from the UI is preceded once by the risk confirmation described under [Control Profiles](#control-profiles). The transition itself is unchanged by whether that acknowledgement is recorded.
- Pending-ask resolution covers only the target session and descendant sessions that inherit its profile. Sessions with their own explicit profile override are not affected.

## SmartAllow

SmartAllow is a constrained policy assistant, not a second permission system. It runs only for eligible capabilities and must clear a confidence threshold. Interactive asks require at least `0.85`; eligible autonomous soft denials require at least `0.90`.

Hard boundaries are never eligible. When a decision involves a secret-like path, SmartAllow receives metadata or redacted evidence rather than raw secret values. Failures and circuit-breaker conditions fall back to the profile decision: `guarded` can still ask, while `autonomous` denies.

## Filesystem and Worktree Boundaries

The active workspace is the default write boundary. Structured tools pass literal path arguments, so the policy layer resolves them against the workspace and approved roots: files outside it may be read when they are not sensitive, including files in the original checkout of a worktree session and durable Asset paths referenced by attachments, while external writes, modifications, and execution remain protected. A shell command string predicts nothing, so its reads, writes, and executions are contained by the sandbox rather than classified here.

Copy-family commands (`cp`, `install`, `ln`) carry no operand-role prediction: their sources and destination are a shell command's filesystem reach, so the sandbox decides which side may be written. The role distinction still governs import/export policy for structured tools, which pass literal paths rather than a command string.

Command-directory changes (`cd`, `pushd`, `env -C`, `sudo -D`, and their wrapped or substituted spellings) are no longer predicted. The sandbox resolves the process working directory and contains the command wherever it lands, so the gate neither aggregates path risk across a pipeline nor emits a conservative opaque external write for an unresolvable target. Explicit external Bash `workdir` values are likewise sandbox-owned.

Shell continuation and stdin data-flow analysis follow actual execution semantics. Escaped newlines are joined before command-name normalization. Interpreter stdin redirects recognize attached or separated descriptor-zero forms such as `sh 0< file`; glued heredoc and herestring descriptors are preserved, while a separated IO number such as `exec 3 <<< ...` remains an ordinary argument. Interpreter wrappers preserve the same source selection. The classifier follows heredoc and herestring bodies replayed through a named descriptor, including fd-copy chains such as `exec 3<<'EOF' … exec 4<&3 … sh <&4`; regular files opened with `exec N< file` and later consumed through `<&N`; descriptor zero inherited by a later stdin-code interpreter; heredoc bodies written to a file and later executed; and process substitutions whose output becomes interpreter input. Data consumers that only print or copy the same text remain non-executing. Inline runtime analysis recursively inspects executable string arguments for process-spawning APIs, including Python `check_call`, `check_output`, `getoutput`, and `getstatusoutput` plus equivalent spawn variants, without treating display-only strings as execution.

Process-substitution payloads are always recursively inspected for executable commands. Their emitted output is treated as interpreter code when the substitution occupies an interpreter's code-file option or positional, or when `<` redirects it into interpreter stdin. With an explicit stdin placeholder, another process-substitution positional is ordinary data unless the substitution supplies redirected stdin, as in `python3 - < <(...)`. Herestring replay recognizes optional whitespace after `<<<` and quote-concatenated payload words. A definite descriptor-0 `exec` command suppresses later replay only while Bash `execfail` is known disabled. `set -o execfail` is inert because `execfail` is a `shopt` option; direct and `eval`-reparsed `shopt` mutations are tracked, while traps, function bodies, sourced code, and other unresolved mutations remain conservative. Inline interpreter string decoding covers hexadecimal `\xNN`, octal `\NNN`, Python `\UNNNNNNNN`, and brace Unicode `\u{...}` escapes. A non-raw Python Unicode-name escape such as `\N{...}` in an executable string is opaque rather than partially decoded; literal double-backslash sequences remain inert until a shell re-parse boundary decodes them.

Interpreter option parsing distinguishes configuration values from executable inputs. Python `-W` / `-X` / `--check-hash-based-pycs` and Bash `-O` / `+O` / `-o` / `+o` consume configuration values before positional analysis. Node `-r` / `--require` designates a code-bearing file. Bash `--rcfile` / `--init-file` always consumes its value but executes that startup file only in interactive mode (`-i`), so interactive targets are recursively inspected while non-interactive values remain inert. Separated and `--option=value` forms are supported, and `--` ends option parsing. An `exec` herestring is also checked against the interpreter invoked in that same segment, including valid clustered `-a` / `-c` / `-l` forms and named-descriptor `<&N` consumption.

Environment wrappers preserve assignments both before and after `env`'s `--` option terminator and expand `-S` / `--split-string` before locating the wrapped executable. Inherited `BASHOPTS=execfail` therefore participates in failed-`exec` replay analysis through direct assignment, plain `env`, `env --`, and split-string forms. Interactive shell invocation (`-i` in the option region) always keeps running after a failed `exec`, so replay analysis applies there without requiring `execfail`; options are scanned only up to the first `-c` / `--command` / `--`, and the attached `-Oexecfail` spelling is treated conservatively for version portability. Lookup-only `command -v` / `-V` forms remain inert, `builtin` unwraps only real shell builtins, and transparent wrappers (`exec`, `nice`, `nohup`, `setsid`, `stdbuf`, `time`, `timeout`, `watch`, `xargs`, `busybox` / `toybox` applets, and the macOS/BSD `script file command ...` positional form) forward `bash -O execfail` unchanged; redirects preceding an `exec` command are skipped, while heredoc bodies remain data. An assignment-looking word after such a wrapper is the wrapper's command name, not an environment assignment. Numeric file descriptors are canonicalized before redirect and replay alias tracking, so spellings such as `03` and `3` identify the same descriptor.

For shell interpreters, `-s` selects stdin as the code source; Python-style `-` placeholders do the same for their runtimes. With an explicit `-` or `-s` placeholder and no stdin redirect, a process substitution supplied as another positional remains ordinary data. Without that placeholder, a process substitution in the interpreter's code-file positional is executable. An explicit `<` or `0<` redirect from a generated file or process substitution is executable stdin and participates in destructive payload classification even when the placeholder is present. Function-definition bodies are treated as opaque because they can defer or disguise a re-parse payload behind builtins, `eval`, shell payloads, or dynamic command names. Unquoted ANSI-C `$'...'` words that contain escapes are conservatively opaque because Bash can decode command names or shell payloads after lexical inspection. Escaped ANSI-C text inside a quoted argument is also opaque when it reaches a shell `-c`, `eval`, `trap`, or `env -S` / `--split-string` re-parse boundary; ordinary quoted display text remains inert. Function definitions preceded by control-flow keywords are likewise opaque rather than partially parsed. Shell payload detection covers executable basenames ending in `sh` plus `fish`, `nu`, `rc`, and `es`, including absolute paths, clustered or attached `-c` flags, long `--command` forms where supported, and `busybox` / `toybox` shell applets; network clients such as `ssh` and `mosh` are excluded from this shell-engine rule. Inline-code receivers are conservatively opaque for Python and PyPy `-c`, Node-compatible and language-runtime evaluation flags, PHP inline processing flags, PowerShell command or encoded-command flags, `deno eval`, and AWK `system()` payloads. Sudo-sensitive inline API inspection recognizes executable calls rather than display-only strings and joins adjacent string literals before checking the invoked command. BSD positional and GNU `--command` forms of `script` are inspected. Docker/Podman `run` and `create` apply last-option-wins `--entrypoint` semantics, including explicit clearing; `exec` does not treat that option as valid, and unknown separated container options fail closed rather than exposing an unchecked payload.

A project Scope can declare multiple project folders (its main worktree plus additional folders persisted in `scope.local.sandboxes`). Every declared project folder is a trusted write root for the session's control profile, sandbox policy, and file-tool containment checks — reads and writes inside any project folder behave like the active workspace and do not require per-path approval. The canonical derivation is `Scope.Root.projectRoots` / `trustRoots` / `executionRoots`; gate creation sites must consume `executionRoots` rather than reconstructing one directory.

In a `git_worktree` session the original main checkout is excluded from the project trust roots and stays outside the trust boundary. An autonomous worktree session can inspect its original checkout but cannot write there or run commands from it. Approved external roots can be added to the execution sandbox for the authorized operation. Sibling worktrees declared as project folders are trusted — only the original checkout remains external.

Sandboxed worktree sessions still run git against the original checkout's object store. The gate seeds enumerated sandbox-only read grants — the worktree's per-worktree administrative files (HEAD, commondir, the gitdir backlink, plus index, ORIG_HEAD, and config.worktree when present) together with the common store's `objects` and `refs` and its `config`, `packed-refs`, `info/exclude`, and `info/attributes` when present — after validating that the worktree `.git` pointer resolves under `<checkout>/.git/worktrees/`, its `commondir` resolves exactly to `<checkout>/.git`, and the metadata entry's gitdir backlink resolves exactly to this workspace's pointer, which stops a pointer aimed at a sibling worktree's metadata entry. Optional files are existence-filtered so bind-based backends (the Linux helper) never receive a missing source. On macOS the deny-default read deny-list already covers these paths, so the grants only gate what bind-based backends mount; the grants never enter writable roots, and any validation mismatch yields no grants (fail closed), so common-store writes fail at the sandbox instead of mutating the shared repository.

Configured skill roots and plugin skill roots are trusted runtime areas. Access inside those roots is not treated as an arbitrary external write or execution unless the requested path escapes the trusted root. Read roots grant only read access; they never authorize modifying or executing an attachment or other external file.

## Sandbox Enforcement

The permission gate decides whether an operation is authorized; the sandbox constrains the process after authorization. Its filesystem modes are:

- `none` — do not add an OS sandbox
- `read_only` — expose readable roots without workspace writes
- `workspace_write` — permit writes inside the workspace and approved writable roots

Network policy is represented separately as full or restricted access. Restricted sandboxes still support the local bindings and runtime channels explicitly required by the execution environment.

The macOS sandbox allows native Keychain service lookup through `com.apple.SecurityServer` alongside `com.apple.securityd` in both filesystem modes and both network modes. Authorized CLI commands such as `gh` can use their existing Keychain login when no managed token is injected. This service access applies to every sandboxed process and remains subject to macOS Keychain access controls; it is not a GitHub-only credential grant. Filesystem read denies and write containment do not constrain operations mediated by the Keychain service, so `read_only` does not imply a read-only Keychain. See the [Keychain service decision](../decisions/implemented/bug-fix/2026-09-21-macos-keychain-service-access.md).

Synergy compiles the policy into platform-specific wrappers: Seatbelt on macOS, a Linux sandbox helper, and Windows/WSL-specific restricted execution paths. The configured fallback (`deny`, `warn`, or `allow`) determines what happens when the requested sandbox cannot be enforced on the current platform. macOS and Linux share one read model: file reads are allowed globally and only the credential and sensitive-data deny list stays unreadable. `READ_DENY_PATHS` is that deny set — derived from both the OS home and the Synergy runtime home when it differs, with tool-compatibility read exemptions for `~/.kube` and `~/.docker/config.json` recorded as an operator decision — and the platform-neutral `readDenyPathsFor` owner compiles it for both backends so the two cannot drift. Because reads are global, a host path the policy layer never predicted is still readable: the macOS deny-default Seatbelt profile imports Apple's `system.sb` — probes on current macOS releases show a hand-rolled deny-default profile aborts every child (SIGABRT) without it, while the import keeps processes viable and scoped allows/denies effective — then emits a bare `(allow file-read*)` plus one subpath deny per entry, and the subpath deny is more specific than the bare global allow and wins, keeping SSH/GPG/cloud/agent-config credentials and browser/mail stores unreadable while tool configurations anywhere on the host stay readable. The Linux helper realizes the same contract through its mount plan (below). Write containment is unchanged on both: writes are denied everywhere except the writable roots.

Stable Linux and Windows runtimes package an architecture- and ABI-matched helper. The runtime embeds that helper's SHA-256 during compilation and verifies it before execution; a Stable build fails when the required helper asset is absent. Linux uses either a verified optional bundled Bubblewrap binary or the system `bubblewrap` package. The Debian installer declares Bubblewrap as a dependency. When the interactive CLI installer detects `apt-get`, `dnf`, or `pacman`, it offers to install a missing package after explicit confirmation; non-interactive runs, declined or failed installation, unsupported package managers, and portable archives leave Bubblewrap as an external prerequisite.

An explicit policy authorization can mark a shell operation as sandbox-bypassed. Otherwise, Bash receives the resolved sandbox wrapper when its profile mode is not `none`. Profile auto-allow under `autonomous` never bypasses the sandbox: unattended profile-permitted Bash runs inside the `workspace_write` wrapper so writes that static classification cannot see (variable redirect targets such as `out=/tmp/…`) are contained at execution time instead of landing on the host. `guarded` user-rule/SmartAllow/approved operations and `full_access` keep the historical bypass behavior. Because the read model is a deny list, a gate-approved external read executes inside the sandbox without the wrapper having to forward that path as a read root, and `/etc` with `resolv.conf` and the systemd-resolve paths are reachable in every network mode rather than by a per-mode bind; the session key scopes the controlled temp root so concurrent sessions cannot see each other's sandbox temp files.

The `autonomous` profile's writable roots include a controlled temporary root at `<workspace>/.synergy/tmp` (session-scoped as `synergy-<pid>-<session>` when a session key is available), reusing the Linux controlled-tmp precedent. Sandboxed Bash points `TMPDIR`/`TMP`/`TEMP` at that root, so tools that honor `TMPDIR` write inside the workspace boundary; literal writes to the root classify as ordinary workspace `file_write`, while the host's shared temporary directory remains an external write. Because `autonomous` never prompts, its sandbox fallback defaults to `deny` (fail-closed): when the OS sandbox cannot be prepared, the operation is refused rather than run unsandboxed. Operators can override through `sandbox.fallbackPolicy`, `sandbox.enabled=false`, or switching to `guarded`/`full_access`; `guarded` keeps `warn`.

The sandbox network mode follows the gate-approved network capability: when the gate approves a network command (`git fetch`, `curl`, `npm install`) the compiled profile uses full networking, otherwise it stays restricted; macOS full networking pairs `(allow network*)` with system.sb's `(system-network)` helper so DNS/SystemConfiguration lookups resolve under `(deny default)`. Deny-list entries are all kept except one equal to the workspace itself; each kept entry is emitted on whichever side of the parameterized writable-root allow makes it effective, because Seatbelt applies the last matching rule rather than ranking by specificity — a project nested inside a credential directory works while its credential siblings remain unreadable. Writable-root `.git` protection is granular: only `.git/hooks` and `.git/config` stay read-only, leaving objects/refs/HEAD/index writable so `git commit`/`git branch` keep working while the tamper/code-execution surface remains protected; `.agents`/`.codex` stay blanket-protected.

On Linux the helper realizes the shared read model as a full-read bind. The profile declares `/` as its single readable root, so the plan starts from `--ro-bind / /` and one recursive read-only bind covers the workspace, the platform defaults, the gate-forwarded roots, and the dynamic-linker entry points (`/lib`, `/lib64`) that restricted-mode children need to start at all. Credential and sensitive paths are the deny set `readDenyPathsFor` produces for every backend; bwrap has no deny rule, so the helper covers each denied path instead — an empty tmpfs for a directory and the null device for a regular file, because a tmpfs destination must be a directory. Cover ordering replaces macOS's specificity resolution with mount order: a cover mounts after the read-only binds that would otherwise re-expose it and before the writable-root bind that contains it, so a workspace nested inside a credential directory keeps working while its credential siblings stay hidden; a deny equal to or inside a writable root mounts after that bind so the deny wins, and a covered path is never also read-only bound. A covered path's target is resolved first, since bwrap refuses to mount over a symlink destination and a credential store such as `~/.ssh` is commonly a link. Every cover source must exist — bwrap hard-fails on a missing mount source — and the helper's permission profile is staged under `~/.synergy/cache/synergy-sandbox/`, a sandbox read root that the final controlled-`/tmp` bind never shadows, so stage 2 re-reads the same absolute path inside the sandbox; homes or workspaces that cannot host it fall back to the workspace controlled tmp and then the host tmpdir with a warning, where only stage 1 reads the file. See [the decision record](../decisions/implemented/simplification/2026-09-19-linux-sandbox-full-read-model.md) and [the read-deny workspace-shape record](../decisions/implemented/bug-fix/2026-09-19-read-deny-survives-every-workspace-shape.md).

The backend also owns the helper's own visibility: the mount plan re-execs the helper inside the sandbox (stage 2), and the plan's final controlled-`/tmp` bind shadows every host path under `/tmp` — including a helper resolved from a tmpdir test home. `LinuxBackend.prepare` stages a verified copy of such a helper into `~/.synergy/cache/synergy-sandbox/` (never under `/tmp`), execs that copy, and binds the exec copy's directory as a read root. Callers grant read roots for their own data and never need to know about the two-stage re-exec; the enforced CI end-to-end runs with no caller-side helper grant.

## OOM Victim Preference

On Linux, Synergy increases the chance that local Bash tool processes are selected before the core runtime during an out-of-memory kill.

- The systemd user service unit sets `OOMPolicy=continue`. When a child in the service cgroup is killed by the OOM killer, systemd does not automatically stop the remaining service processes; the kernel can still select the main process independently.
- After permission resolution, local Linux Bash prefixes the materialized command with a best-effort write of `1000` to `/proc/self/oom_score_adj` before sandbox preparation. This makes the tool child a preferred victim; the write is silent on failure and never blocks the command.

These are victim-preference hints, not hard memory limits or cgroup constraints. Remote Link Bash and non-Linux local Bash are unchanged.

Local child-process completion has a separate output-drain boundary. The parent exit event stops command timers, while stdout and stderr remain attached long enough to preserve finite tail output. Completion normally settles on the close event. If an untracked descendant inherits those pipes and keeps them open, the direct user shell and foreground Bash paths that do not authorize detached daemons wait a bounded one-second grace period, then terminate their owned process boundary before destroying local pipe handles and settling. On Unix, Synergy wraps the command with a short-lived sentinel that preserves the owned process-group identity after the direct shell exits; cleanup signals only that process group and does not claim descendants that create a new session or process group. On Windows, Synergy owns the command tree with a kill-on-close Job Object; termination falls back to closing the retained owner handle, and a close failure preserves the owner for retry. Authorized Windows detached daemons are rejected while an active sandbox Job would still own them; operators must use `full_access` or an explicitly policy-approved sandbox bypass.

## Session and Workflow Restrictions

Authorization is also constrained by the current session role. Plan supplies Blueprint-oriented prompt guidance without restricting tools; the selected control profile remains the authorization boundary. Delegated subagents normally cannot re-delegate, operate the task graph, or ask permission questions. Internal reviewers can receive a deliberately configured delegation group without becoming user-selectable primary agents.

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
- bash contributes only the capabilities the OS sandbox cannot express; it predicts no filesystem path, so redirect targets, null-device sinks, and external paths inside a command string carry no gate-side classification.
- `full_access` authorizes capabilities but cannot turn runtime failure into success.
- Sensitive values are never sent raw to SmartAllow.
- Worktree isolation protects writes and execution outside the active worktree.
- A workflow or agent restriction can remove a tool even when the control profile would allow its capability.

## Native Computer eligibility

`computer_observe` and `computer_interact` require the `full_access` profile, including window discovery and screenshots. Ordinary permission rules and session approvals cannot enable these capabilities in another profile. Native OS permissions and app-specific background support remain runtime prerequisites. See [Native Computer Use](computer-use.md).

Bash secret substitution keeps a standalone, unquoted local token in a quoted environment expansion so whitespace and metacharacters remain one argument. Quoted, embedded, heredoc and remote substitutions accept only shell-inert credential characters; other values fail explicitly instead of introducing shell syntax. Vault rotation rejects values already registered under another entry, preserving its policy and audit history. Secret API conflicts return 409; storage failures remain server errors rather than false 404 responses.
