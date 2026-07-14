# Core Runtime Rules

These rules apply under `packages/synergy`. Root [AGENTS.md](../../AGENTS.md) still applies.

Load `integrate-llm` for every new or changed model-backed operation, `change-server-api` for HTTP/OpenAPI/SDK contracts, `change-persistence` for durable state or migrations, `change-execution-boundaries` for capability/permission/sandbox changes, `change-browser-runtime` for Browser ownership/control, and `change-plugin-runtime` for plugin host/runtime changes.

## Read the Owning Contract

Start from [Architecture](../../docs/architecture/README.md), then read the document for the subsystem being changed. Trace adjacent domains and tests before editing; `session/`, `server/`, `tool/`, `enforcement/`, `storage/`, and `bus/` frequently cross directory boundaries.

## Runtime Invariants

- Session/message fields are orthogonal: task grouping (`rootID` / `isRoot`), rendering (`visible`), model context (`includeInContext`), and provenance (`origin`). Use `MessageV2.deriveSemantics()` and `MessageV2.isSystemPart()`; do not restore retired booleans. See [Sessions and messages](../../docs/architecture/session-and-messages.md).
- Bind every assistant message in one task to the root user message. Preserve serial root-task execution, inbox `mode`, compaction anchoring, and continuation semantics.
- Preserve frontend sync contracts when changing server events or snapshots: scope-monotonic `seq`, runtime `epoch`, replay journal, snapshot watermark headers, unsequenced streaming deltas, immediate terminal events, and write-behind part persistence. See [Frontend data sync](../../docs/architecture/frontend-data-sync.md).
- Cortex delegation creates durable child sessions with explicit lineage, visibility, tools, timeout, and output contract. Do not hide work in one message history or create a parallel in-memory mailbox. See [Cortex](../../docs/architecture/cortex.md).
- Plan, BlueprintLoop, Light Loop, and Lattice are mutually exclusive session workflows with host-owned continuation/review rules. WorkflowRun is the Scope-level Boss/seat state machine beside them; its snapshot owns entity, lease, gate, effect, budget, and recovery state. See [Workflows](../../docs/architecture/workflows.md).
- `observability/` owns canonical telemetry context, redaction, indexed SQLite storage, writer backpressure, events, metrics, spans, issues, resource samples, migrations, and diagnostics. `performance/` is the product/API read model over that store and must not reintroduce generic stores, writers, redaction, span lifecycle, or JSONL runtime query paths. See [Performance observability](../../docs/operations/performance-observability.md).

## Execution and Security

Keep ownership separate:

- `control-profile/` resolves user-facing profiles
- `enforcement/` classifies capabilities and makes boundary decisions
- `permission/` stores/evaluates permission rules and SmartAllow
- `sandbox/` wraps OS process execution
- `session/tool-resolver.ts` assembles and executes the active tool pipeline

`guarded` may ask; `autonomous` never asks; `full_access` silently allows permission capabilities. Ordinary external reads are allowed unless sensitive; worktree writes/modification/execution remain protected. Skill roots are trusted only while an operation stays inside the configured root. See [Execution boundaries](../../docs/architecture/execution-boundaries.md).

Do not move centralized checks into individual tools or treat an unavailable sandbox as a permission grant. Keep OS helpers on the shared permission-profile contract and preserve platform-specific readiness/fallback diagnostics.

## Persistence and Migrations

- Build logical JSON keys through `StoragePath` and use `Storage` for locking and atomic writes.
- Put versioned upgrades/backfills in the owning `*/migration.ts` and register them through `migration/`.
- Test fresh data, representative old data, idempotence, dependency ordering, and startup execution.
- Keep compatibility readers only where migration cannot make old records impossible.
- Use [Storage and paths](../../docs/reference/storage-and-paths.md) as the layout reference; do not duplicate a storage tree here.

## Providers, Config, and Plugins

- Resolve provider existence and model roles through profiles/catalog/config. Keep remote catalog data declarative and verified.
- Keep `openai-codex` device-code OAuth and Codex transport separate from the `openai` Platform API-key provider.
- Let real model, usage, and discovery requests drive provider auth recovery and health transitions; do not add startup or periodic third-party credential probes.
- Canonical config lives in domain files; add migrations rather than a monolithic runtime loader.
- Plugins declare Host Service capability ceilings before import. Preserve ID consistency, approval hashes, process/inProcess selection, generation checks, scoped Host Service enforcement, and contribution-level failure isolation. See [Plugin runtime and capabilities](../../docs/plugins/runtime-and-permissions.md).

## LLM-Backed Operations

- Keep metadata extraction, classification, and other non-durable derived work sessionless through the shared `LLM` layer.
- Continue work in an existing session through `SessionInvoke`; launch inspectable delegated or reviewed child work through Cortex.
- Do not treat the private `callAgent()` in Experience Encoder as a shared API or copy it into another domain. Follow `integrate-llm` when consolidating sessionless callers such as title, summary, or SmartAllow.
- Reserve direct AI SDK calls for provider/bootstrap probes and the shared LLM implementation boundary.

## Tools and APIs

- Define tools with `Tool.define()` and match the nearest implementation. Use precise Zod parameters, honor cancellation, return structured metadata, and preserve permission expectations.
- Register new first-party tools through the `add-tool` workflow, including taxonomy and Web registrations.
- Add OpenAPI metadata to server routes and run `./script/generate.ts` from the repository root after route/schema changes.
- Keep streams on their established WebSocket, SSE, or data-channel transports; use generated SDK contracts for ordinary HTTP APIs.

## Browser Runtime

`packages/browser` owns Protocol v2 and shared CDP semantics; `src/browser` owns sessions, persistence, Host brokering, authenticated network transport, and lifecycle. Preserve one session to one page. State reads, event connection, and WebRTC signaling do not create a page; first navigation does. Use the server-provided canonical owner key and keep native Desktop and remote Web presentation separate from shared host/page ownership. Read [Browser runtime](../../docs/architecture/browser-runtime.md) before editing these contracts.

## Tests and Commands

Run core commands from this package:

```bash
bun run typecheck
bun test test/<domain>/<file>.test.ts
bun run test:changed
bun test
bun run test:coverage
```

Provider/model tests use `test/tool/fixtures/models-api.json`, never a live catalog. Use real temporary Scope/storage fixtures and test behavior rather than source text. Then run `bun run quality:quick` from the repository root.

Run source/manual tests in an isolated `SYNERGY_HOME`; never restart the active runtime. Load `develop-synergy` for the procedure.

## Documentation Sync

Update the canonical docs and relevant `.synergy/skill` when changing routes, CLI, agents, tools, config, storage, logs, startup, migrations, workflows, execution boundaries, Browser behavior, providers, plugins, Channels, Holos, Agenda, Notes, or Library. When a reusable runtime-development rule emerges and no Skill owns it, update or create the focused Skill in the same change.
