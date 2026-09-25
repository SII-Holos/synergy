---
name: architecture
description: Navigate and trace the Synergy codebase, identify subsystem ownership, explain a runtime flow, or plan a cross-cutting change from current implementation evidence. Use when locating code, mapping state and event flow, checking architecture boundaries, or assessing impact across runtime, Web, Desktop, SDK, plugins, and persistence.
---

# Trace Synergy Architecture

## Orient

1. Read [Architecture overview](../../../docs/architecture/README.md) and [Package map](../../../docs/reference/packages.md).
2. Select only the relevant canonical documents:
   - runtime/Scope: `runtime-and-scope.md`
   - workspace and files: `workspace-and-files.md`
   - session/message/compaction: `session-and-messages.md`, `llm-loop.md`
   - Web state: `frontend-data-sync.md`
   - Channels and Native Clarus: `channels.md`
   - permissions/tools: `execution-boundaries.md`
   - delegation: `cortex.md`
   - Plan, BlueprintLoop, Light Loop, Lattice: `workflows.md`
   - Browser: `browser-runtime.md`
3. Read the nearest `AGENTS.md` before inspecting package code.
4. Load the focused implementation workflow when the trace becomes a change:
   - Web/shared UI: `develop-frontend`
   - LLM-backed operation: `integrate-llm`
   - HTTP/OpenAPI/SDK contract: `change-server-api`
   - durable state or migration: `change-persistence`
   - capability/permission/sandbox behavior: `change-execution-boundaries`
   - Channel runtime, managed Projects, or Native Clarus: `change-channel-runtime`
   - Browser/Desktop/WebRTC runtime: `change-browser-runtime`
   - plugin public/host/runtime behavior: `change-plugin-runtime`

## Trace from Evidence

1. Identify the user-facing entry point: CLI command, server route, Web action, Desktop IPC, tool, Agenda trigger, Channel event, plugin hook, or migration.
2. Search with `rg` for the public name, schema, event, route operation ID, storage path, and error string.
3. Follow the write path through ownership boundaries. Record the module that validates input, owns state, enforces capabilities, persists data, and emits events.
4. Follow the read/sync path independently. For Web behavior, trace generated SDK calls, snapshot watermarks, bus events, replay, reconcile writes, and loading/eviction.
5. Inspect adjacent domains before concluding that a directory boundary is the abstraction boundary.
6. Verify tests and migrations that encode the behavior. Treat comments, docs, and old design files as supporting evidence only when code/tests agree.

## Produce the Result

For an explanation, report:

- entry point and owner
- state model and persistence
- execution/permission boundary
- events and downstream consumers
- lifecycle, cancellation, retry, and failure behavior
- tests or migrations that prove the invariants
- uncertainties that still require runtime evidence

For a change plan, name the smallest coherent set of owners and verification gates. Include SDK regeneration, config/help/docs sync, or persistence migration only when the change actually crosses those contracts.

Do not reproduce a static directory inventory. Link canonical docs and cite current files or symbols so the analysis survives repository growth.

## Runtime ownership

For file resources, trace the resolved Workspace ID and binding generation through caches, native callbacks and event subscribers. Use `WorkspaceState` for working-file resources and `WorkspaceEvents` for file notifications; project configuration and Scope event sequencing retain Scope ownership. Verify two Sessions sharing one Workspace, two Workspaces sharing one Scope, and rebinding while a stale generation remains in a caller. Native tests must exercise actual filesystem delivery and formatter/LSP processes where affected.

Trace each mutable registry, cache, environment read, callback, child process and timer to its owning Runtime before changing lifecycle code. Imports define capabilities; composition registers them before opening. Native listeners must capture the owner explicitly. Trace all AsyncLocalStorage-based domain contexts too: experiment overrides, per-session migration targets, rollout identities, transport sinks and tool execution callbacks must reject inherited values after a Runtime switch and disappear inside RuntimeContext.exit. A scoped context from another Runtime cannot supply a workspace, credentials or storage. Test interleaved instances and closing one while the other continues, plus failed startup and resource drainage. Scope identity and nullable local metadata are distinct from a session’s explicit nullable workspace; see [Runtime and Scope](../../../docs/architecture/runtime-and-scope.md).

When changing file-history capture, trace physical write admission separately from model-step and tool lifetimes. Preserve one immutable before/after pair per operation and source Workspace, including shared roots and background process completion. Exercise parent/child handoff with an intervening writer, failed capture, cancellation after partial effects and Session deletion. Derived cursors and UI row identity must not merge operation pairs across foreign writes; record incomplete evidence explicitly and refuse to restore it.

For reusable native processes, trace idle lifetime separately from active requests. An unconfined LSP may still write after a query finishes; retain its native claim until tree exit and retire idle clients when the shared coordinator reports contention. Preserve diagnostics and lazy restart, serialize multiple matching servers, and verify concurrent query cancellation, queued startup disposal, installers/probes and temporary-data cleanup with real processes. Reusing a logical task reservation must not bypass physical admission or create an invisible cooperative waiter.

## Component composition changes

Trace each selected package through its `./component` factory, configuration, reload handlers, service disposal and lazy HTTP/CLI adapters. Required dependencies must be explicit; optional ordering must not install a peer. Reuse Harness lifecycle ownership and test two Runtime instances, failure cleanup, role-specific worker readiness and a reduced HTTP schema. CLI helpers belong to shared terminal primitives or Local Runtime host adapters; authoring tools remain optional. Update package exports, the release catalog, test/coverage inventories and clean-directory install checks together.
