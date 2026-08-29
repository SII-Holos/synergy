# Decision Record: Boss vertical slice — provider-based continuation, prompt registry, domain tools

Status: implemented

## Problem

The boss domain (Boss Mode) lived inside the harness-core directories: five modules under `session/` (boss, boss-runtime, boss-continuation, boss-message, boss-prompt) and six tool modules plus descriptions under `tool/`, statically imported by the core loop (`invoke.ts` imported boss-prompt builders and dynamically imported boss-runtime/boss inside its Layer 2.5 switch), statically listed in `tool/registry.ts`'s builtin array, and statically registered by `ContinuationKernel.registerBuiltins()`. This was inversion points P1 (kernel builtin registration), P3 (inlined boss system-prompt branch with channelDeliveryMetadata auto-delivery logic), P5 (boss rows in WorkflowUserWrapper's PROMPT_BUILDERS), and P6 (boss tools in the core registry) applied to one domain.

## Decision

Move the boss domain out of the core and invert its four attachment points through registries, all loaded via the L4 product manifest (`src/product-registration.ts`, `registerBossDomain()`):

- **Move**: `session/boss*.ts` → `src/boss/`, `tool/boss-*.ts|.txt` → `src/boss/tools/` (git history preserved). Consumers (server/boss route, channel routing, runtime reload boss sync, global-runtime ensure) import from the new location.
- **H1 continuation**: `ContinuationKernel` replaces `registerBuiltins()` with `registerProvider(sourceID, () => Policy[])`; providers drain lazily on `init()`/`propose()`/`registeredPolicyIDs()`, preserving the legacy self-heal semantics (the old `propose():83` re-registration safety net) so registration order and entry point cannot drop a policy. `reset()` clears drained state for tests. An empty registry after drain now logs a warning (the one deliberate behavior addition). Boss registers under `"boss"`; blueprint/lightloop/lattice register through a legacy bridge block in the product manifest until their slices (S3–S5) land.
- **H2 prompts**: new L1 `session/workflow-prompt-registry.ts` (`WorkflowPromptRegistry`: `buildSystem(session, ctx)`, `projectUserMessage(query, agentName)`, `controlSources`). `invoke.ts`'s boss case and `WorkflowUserWrapper.build()`'s boss mode delegate to the registry; the boss bytes (delivery-hint matrix, runtime/worker contexts, boss-tree rendering, user-request wrappers) live in the boss domain (`src/boss/register.ts` + `boss-prompt.ts`). The registry ctx carries the per-turn delivery metadata the loop already computed, so the auto-delivery decision logic moved verbatim.
- **H4 tools (boss share)**: `ToolRegistry.registerToolProvider(sourceID, () => Tool.Info[])`; `all()` drains providers after the static builtin list. The six boss tools register under `"boss"`; their static imports and builtin-array entries are removed from `tool/registry.ts`.
- **Docs generator**: `gen-tool-catalog.ts` harvests builtin tool names from domain `register.ts` modules in addition to `tool/registry.ts`, resolving tool files inside each domain directory (recursive scan fallback), so docs/reference/tools.md stays complete without core-directory residency.

Behavior equivalence is locked by the S2a golden contract (`test/boss/prompt-contract.test.ts`, byte-exact) plus the existing boss suites; registry-asserting tests import the product manifest the same way real entry points do.

## Alternatives considered

- **Eager registration at assembly only (no lazy drain)** — rejected: the kernel's safety net was the lazy `registerBuiltins()` call inside `propose()`; dropping laziness would make a failed or skipped assembly step silently disable boss continuations (boss-runtime ensure is warn-and-continue). Providers keep the lazy semantics with named sources.
- **Keep boss prompt builders imported in invoke.ts but move only the files** — rejected: file moves alone would add new `session→boss` edges (the pre-S2 status quo was that boss lived inside session/); the point of the vertical slice is to remove the core→product edge in the same commit as the move.
- **Register boss tools through the plugin contribution pipeline** — rejected: plugins are a process-bound public contract with manifest/Ajv schemas; built-in domains need direct typed `Tool.Info` objects. The provider map reuses the existing builtin list shape.
- **Per-domain ToolRegistry modules with static imports from registry.ts** — rejected: that would keep the core importing the domain, recreating P6 with different syntax.

## Consequences

- `session/` and `tool/` no longer contain boss code; L1→product edges for boss are gone (kernel, invoke, wrapper, registry all query registries). The S2 budget holds at 48→46 expected after the lightloop/blueprint/lattice legacy bridge lines settle (bridge lines live in the L4 manifest, not L1).
- Domains that need registration completeness at startup rely on `product-registration.ts` being imported by both entry chains (`main.ts`, `server/runtime.ts` + daemon); the kernel's lazy drain plus the empty-registry warning covers direct-invoke CLI paths.
- Tests that assert registry contents import `src/product-registration` (kernel, boss tools) — the same contract as production entries.
- `WorkflowUserWrapper` boss-mode wrapping now depends on boss registration; without it, boss user messages pass through unwrapped (registry miss → passthrough), which is the correct degradation when the domain is absent.
- The boss-runtime suite has two 5s-timeout-boundary tests that occasionally exceed the default timeout under load (5.01s vs 5.00s); they pass with a 30s timeout and are pre-existing timing characteristics, not functional regressions.
