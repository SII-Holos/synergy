# Decision Record: Session module source inversion — clearing session's product edges

Status: implemented

## Problem

The S9 tool partition left the L1 `session/` module importing thirteen product domains (agenda, blueprint, channel, command, cortex, external-agent, library, lsp, mcp, note, plugin, project, question) across ~22 files: the invoke loop's prompt/turn assembly, the recovery pass, memory recall, the environment prompt, navigation indexing, and the input resolver all reached directly into product stores and services. This kept `session/` entangled with every product domain's internals and blocked the harness-core layering program's final L1 slice.

## Decision

Invert all thirteen edges through L1 registries plus product-side adapters, following the `SessionToolContext` (P9) and `SourceProviders` (H7) precedents exactly — register/get with quiet degradation, wiring owned by `src/product-registration.ts`:

- **Behavioral ports**: `session/blueprint-state.ts` (loop store + active-status + `<blueprint-loop-context>` rendering), `session/project-health.ts` (git health + worktree locking/binding/detach), `session/library-recall.ts` (always/contextual memory + experience retrieval/encoding), `session/note-access.ts` (blueprint note projections for recovery), `session/cortex-runtime.ts` (delegated context, reminders, blockers, parent-notification reconciliation, abort cancel, plugin task snapshots), `session/agenda-signals.ts` (wake-up reminders + continuation blockers), `session/command-runtime.ts` (require/runAction/errors/Executed event), `session/external-agents.ts` (adapter + processor bridge), `session/plugin-hooks.ts` (trigger + triggerForPlugin delivery with initial-value passthrough), `session/question-errors.ts` (RejectedError class registration), `session/input-source.ts` (MCP resource reads + LSP document symbols), `session/managed-projects.ts` (channel ownership rows for the nav index), `session/env-contributor.ts` (advisory env hint lines; superplan registers without touching L1).
- **Type relocations into L1** (persistence owner holds the schema; product re-exports the identical zod value): `session/symbol-range.ts` (was `lsp/schema.ts` Range), `session/channel-endpoint.ts` (was `channel/types.ts` ChannelTarget/Info/toKey), `session/cortex-contract.ts` (was the OutputConfig/TaskOutput/PluginTaskOwner/TaskUsage half of `cortex/types.ts`).
- **Chronicler side effect** moved from `invoke.ts` to the manifest: `import "./library/chronicler"` now appears in `src/product-registration.ts` (assembly-owned).
- Adapters live in the product domains as `<domain>/session-*.ts` (blueprint/session-state, project/session-health, library/session-recall, note/session-access, plugin/session-hooks, command/session-runtime, cortex/session-runtime, external-agent/session-bridge, agenda/session-signals, question/session-errors, mcp/session-input, lsp/session-input, channel/session-projects, superplan/session-env) and all fifteen register through the manifest.

## Alternatives considered

- **Shimming or re-exporting product modules into session** — rejected: violates the Blueprint's no-compatibility-path rule; one current path after the inversion is the requirement.
- **Moving the recall/cortex rendering logic into the product domains** — rejected: the byte-level prompt contracts (memory blocks, cortex reminders, agenda reminders) are session's Layer 3–6 prompt assembly; only the data access crosses the boundary.
- **Keeping the chronicler import in invoke.ts as a manifest-comment** — rejected: the Blueprint mandates the side effect be owned by the assembly point; a comment cannot load a module.

## Consequences

- `bun run deps:analyze`: the `session ->` line under "L1 -> product edges" is gone (29→13 remaining L1→product edges, all owned by parallel workstreams: config/agent/enforcement/permission/provider/scope/tool/workspace-file).
- Behavior is byte-equal: the full `SYNERGY_TEST_HOME=1 bun test test/session/` suite passes 1055/1055; `tsgo --noEmit` is clean.
- Tests exercising inverted paths now mount registrations explicitly (product-registration or the specific `register*` function) — `prompt-roots`, `invoke`, `command-kind`, `working`, `recovery`, `workflow`, `nav-managed-project` each pass in isolation.
- `lsp/schema.ts`, `channel/types.ts`, and `cortex/types.ts` remain as product surfaces re-exporting the L1-owned schemas, so no importer outside session had to change.
