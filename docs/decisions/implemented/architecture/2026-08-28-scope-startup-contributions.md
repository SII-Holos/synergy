# Decision Record: Scope startup contributions — H5 StartupContribution registry

Status: implemented

## Problem

Inversion point P7 (scope half): `scope/runtime.ts` (L1) statically imported six product modules — `@/command/command` (INIT event watcher), `@/lsp`, `@/plugin` (activate/init/disposeScope), `@/project/vcs`, `@/lattice/runtime`, plus reached `Plugin.disposeScope` during disposal — to run ten initialization steps in a fixed order. Every new product startup requirement forced another L1 import, and the order-sensitive chain (session-recovery → lattice → resume-pending) lived only as array position.

## Decision

Introduce `scope/startup.ts` (L1): a `ScopeStartup` contribution registry with deterministic topological execution.

- **Contribution shape**: `{ name, phase: "core"|"workflow"|"surface", after?, before?, init(scope), dispose?(scopeID) }`. Ordering ties break by (phase rank, registration rank); unknown ordering references and cycles throw loudly instead of silently skipping steps.
- **Built-in anchor chain**: the harness-owned steps (starting-listeners, session-recovery, activity-summary, resume-pending, format, file-watcher) are modeled as a chained anchor list inside the registry; product contributions pin themselves between anchors with explicit before/after.
- **Domain contributions** (registered through `src/product-registration.ts`): `plugin/startup.ts` (plugin-activate before listeners, plugin-init after listeners before recovery, disposeScope on scope disposal), `lattice/startup.ts` (after session-recovery, before activity-summary/resume-pending — the order-sensitive chain from the Blueprint), `lsp/startup.ts` (after format, before file-watcher), `project/startup.ts` (vcs after file-watcher), `command/startup.ts` (INIT-command watcher last, per-scope unsubscribe on dispose).
- **`scope/runtime.ts`** keeps only lifecycle bookkeeping (started/disposing maps, starting listeners) and delegates the step sequence to `ScopeStartup.run`; disposal runs contribution `dispose` hooks before `ScopedState.dispose`.
- **Behavior equivalence**: the historical twelve-step order is reproduced exactly and asserted by `test/scope/startup.test.ts` (registration canary, full pairwise order assertions on `ScopeStartup.plan()`, loud-failure on unknown ordering references). `test/scope/runtime.test.ts` order test (`activate → listener → init`) still passes with the plugin contribution mounted.
- **Reload contract**: `ToolRegistry.reload()` resets registry state so providers re-drain on next access (established S2 semantics); `ContinuationKernel.reset()` clears drained providers (established S2 test coverage). H5 adds no new reload state.

## Alternatives considered

- **Keeping the ordered init list in scope/runtime.ts with injected functions** (the setTerminalHookDeliverer pattern) — rejected: six injection setters duplicate the registry and still hard-code order in L1; the Blueprint specifies a contribution registry with explicit ordering declarations.
- **Phase-only ordering without a topological sort** — rejected: the lattice chain crosses phase boundaries (core anchors → workflow lattice → core-named activity-summary/resume-pending); only explicit before/after edges can pin it.
- **Running contributions concurrently within a phase** — rejected: historical behavior is strictly sequential; parallelism would be a behavior change.

## Consequences

- Snapshot: L1→product edges 34→29 (scope→command, scope→lattice, scope→lsp, scope→plugin, scope→project removed; scope→library remains via `scope/migration.ts` library-cleanup steps — see the S9 scattered-edge record).
- Mis-registered ordering now fails at startup with a named error instead of silently reordering initialization.
- Product domains gain startup self-registration; `global-runtime.ts` assembly remains L4 and is not part of this record (its BossRuntime/Channels/Agenda imports are assembly-layer by design).
