# Plugin Runtime and Permissions

Synergy evaluates a plugin before importing it and continues enforcing the approved boundary while it runs. Source provenance, package integrity, declared permissions, approval, trust, runtime isolation, and per-call enforcement are related checks, not interchangeable labels.

## From Source to Running Plugin

The lifecycle is:

1. Resolve the plugin source and canonical ID.
2. Read and validate `plugin.json` without importing runtime code.
3. Verify package structure, hashes, and signatures where the source requires them.
4. Derive install capabilities and risk from the manifest.
5. Compare the request with the stored approval and configured approval policy.
6. Select the effective trust tier, runtime mode, and resource limits.
7. Load the descriptor and verify discovered contributions against the manifest.
8. Route runtime calls through direct host services or the isolated host bridge.

A failure disables that plugin with a reason. It does not remove built-in tools or stop unrelated plugins, MCP servers, or sessions.

## Sources and Trust

Plugin sources are classified as `builtin`, `local`, `official`, `npm`, `git`, or `url`.

| Source            | Current trust decision                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| Built-in          | `trusted-import`                                                                      |
| Official registry | `trusted-import`; the registry-reviewed package is integrity-verified                 |
| Local path        | `trusted-import`; intended for author-controlled development                          |
| npm               | `trusted-import` only with explicit trust and verified integrity; otherwise `sandbox` |
| Git               | `trusted-import` only with explicit trust; otherwise `sandbox`                        |
| URL               | always `sandbox`                                                                      |

The trust-tier type also includes `declarative`, but the current source resolver assigns executable plugins either `trusted-import` or `sandbox`. Declarative UI fallbacks and form schemas are still useful, but should not be confused with the installed plugin's current trust decision.

Trust does not grant capabilities. It helps determine whether code can be imported and where it executes; the approved manifest remains the capability ceiling.

## Approval

An approval record binds consent to:

- canonical plugin ID and source
- version
- manifest and permissions hashes
- approved capability strings
- approved UI surfaces
- calculated risk

Changing the manifest or permission hash invalidates the old approval. Updates therefore surface newly requested capabilities instead of inheriting consent by plugin name alone.

The approval policy can auto-approve built-ins, allow unsigned local development with consent, require signatures for non-local sources, or deny high-risk third-party plugins. Registry installation uses the same approval path as direct installation.

Inspect the active declaration and decision with:

```bash
synergy plugin info <id>
synergy plugin permissions <id>
synergy plugin runtime status <id>
```

## Runtime Modes

The effective mode is one of:

- `in-process` — the descriptor runs in the Synergy server process.
- `worker` — the descriptor runs in a worker and communicates with the host.
- `process` — the descriptor runs in a separate process and communicates through a bounded protocol.

The manifest's `runtime.mode` is a request. Host policy can select a stricter mode:

- third-party sources default to `process`
- high-risk plugins require `process` by default
- an explicit `process` request is honored
- a `worker` request requires worker mode to be enabled and the plugin to be trusted
- third-party `in-process` execution is disabled by default
- local `in-process` execution can be disabled by policy

Worker mode does not fully support shell, file-write, or MCP-spawn capabilities; validation warns authors to use process mode for those operations.

Resource policy covers startup, tool, hook, bridge, delegated-task, and shutdown timeouts; concurrent requests; log rate; memory polling; and heartbeat failure. Global defaults come from `pluginRuntimePolicy`, then a manifest can provide valid positive overrides in `runtime.resources`.

## Capability Layers

The broad manifest permissions are the maximum capabilities the plugin can request. Each declared tool then supplies its own narrower capability profile. Runtime enforcement uses the actual operation and current session boundary.

Examples include:

| Manifest declaration      | Runtime capability family         |
| ------------------------- | --------------------------------- | --------------------------------- |
| `tools.shell: true`       | shell execution                   |
| `tools.filesystem: "read" | "write"`                          | file read or write                |
| `tools.network: true`     | network access                    |
| `tools.mcp: "invoke"      | "spawn"`                          | MCP invocation or process startup |
| `tools.task`              | delegated Cortex task             |
| `data.session`            | session metadata or content       |
| `data.workspace`          | workspace metadata or content     |
| `data.config`             | plugin or global configuration    |
| `data.secrets: "own"`     | the plugin's credential namespace |
| `permissions.ui: true`    | declared Web UI surfaces          |
| `permissions.hooks`       | event and mutation hook families  |

Unknown plugin tools are treated as protected opaque operations rather than silently inheriting the plugin's other tools.

## Isolated Host Bridge

Worker and process runtimes receive proxies for host-owned services. The bridge maps requests for configuration, credentials, cache, files, shell, network, session/workspace data, delegated tasks, and tool invocation to the corresponding approved capability.

File and shell requests require an active plugin tool call. They therefore inherit the current Scope, directory, control profile, permission decision, and sandbox boundary rather than becoming ambient plugin powers.

`context.task.run()` is gated by `permissions.tools.task`, including any declared agent allowlist and maximum runtime. `context.tools.invoke()` can invoke only tools visible or explicitly allowed in the current execution context.

## Hooks

Hooks can observe or transform runtime behavior, so their permission declaration matters as much as tool permissions. The SDK currently includes:

- runtime lifecycle, config, and event hooks
- chat-message, parameter, system-prompt, model-history, compaction, and text transforms
- permission and tool before/after hooks
- completed session-turn and Cortex-task hooks
- Agenda run hooks
- Note create, update, and search hooks
- Library memory-search and experience-encoding hooks

Use the narrowest hook declaration: selected event names instead of all events, own tools instead of all tools, and explicit transform flags only where the plugin actually mutates model input or output.

## Plugin-Owned State

Plugin configuration lives in the plugin's config namespace. Cache values live under the plugin cache directory and may carry a TTL.

Plugin credentials currently use unencrypted JSON at:

```text
~/.synergy/data/plugin/<id>/auth.json
```

Treat the filesystem containing `SYNERGY_HOME` as sensitive. Do not put unrelated secrets in plugin config, cache, logs, tool output, or packaged assets.

## Recovery and Diagnosis

```bash
synergy plugin list
synergy plugin runtime status <id>
synergy plugin doctor
synergy plugin doctor --fix
```

Doctor detects and, where safe, repairs duplicate specs, stale lock entries, broken archive cache records, missing resolved paths, and runtime-state entries for removed files. It does not manufacture a valid package when the original artifact is unavailable or invalid.

See [Security](security.md) for the author and reviewer checklist.
