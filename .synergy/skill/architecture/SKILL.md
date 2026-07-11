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
