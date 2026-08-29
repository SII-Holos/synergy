# Decision Record: Blueprint vertical slice — host-adapter injection dissolves the plugin→blueprint edge

Status: implemented

## Problem

The Blueprint domain was split across three layers: continuation and review-access lived under `session/`, the three lifecycle tools (`blueprint_loop_stop/approve/reject`) under `tool/`, and the `<blueprint-loop-context>` system block was inlined in `session/invoke.ts` (~38 lines of prompt assembly with audit/execution/lattice variants). This was inversion points P1/P3/P6 applied to the blueprint domain, plus the P10 product-layer cycle: `plugin/host-services.ts` statically imported `blueprint/plugin-adapter` while `blueprint/loop-store.ts` imported `Plugin.deliverHookForPlugin`, and `plugin/lifecycle.ts` statically imported `BlueprintLoopRuntime` for timer reattach.

## Decision

Complete the blueprint vertical slice (S4) through the L4 product manifest:

- **Move**: `session/blueprint-continuation.ts` → `src/blueprint/continuation.ts`; `session/blueprint-loop-review-access.ts` → `src/blueprint/review-access.ts`; `tool/blueprint-loop-{stop,approve,reject}.{ts,txt}` → `src/blueprint/tools/`. The builtin tool array in `tool/registry.ts` drops the three tools; `session/tool-resolver.ts` follows the moved review-access.
- **S4a golden first**: `buildBlueprintLoopContext` is extracted byte-exact into `src/blueprint/prompt.ts` and locked by `test/blueprint/prompt-contract.test.ts` (audit instruction with both verdict tools, synergy-max and generic execution variants, lattice boundary sentences, start-user-instruction contract lines, description/status projection, and the `blueprint_loop_*` control-source suppression set). `invoke.ts` renders the block through the extracted builder.
- **H1 continuation**: `registerBlueprintDomain()` registers `BlueprintContinuationPolicy` under `"blueprint"`; the manifest's legacy-bridge line is deleted.
- **H2 contribution**: the domain registers a `"blueprint"` prompt contribution carrying the `blueprint_loop_{start,continuation,rejected}` control sources and `reattachPluginTimers` (delegating to `BlueprintLoopRuntime`). `"blueprint"` is not a workflow kind — BlueprintLoop sessions carry `session.blueprint`, not `session.workflow` — so the contribution exists for the control-source set and the plugin-reload timer fan-out; `plugin/lifecycle.ts` drops its direct `BlueprintLoopRuntime` import and relies entirely on the registry fan-out (completing S3's pending leg).
- **Host-adapter injection (P10)**: `plugin/host-services.ts` replaces its static `blueprint/plugin-adapter` import with a `PluginBlueprintAdapter` slot (`registerPluginBlueprintAdapter`). The manifest wires `startBlueprint/getBlueprint/cancelBlueprint` into the slot, dissolving the plugin→blueprint direction; `blueprint→plugin` (terminal hook delivery) remains the allowed one-way composition edge. Adapter absence fails loudly with a load-the-manifest error.
- **Agenda guard injection**: `blueprint/tools/blueprint-loop-stop.ts` consumes the Agenda wakeup guard through an injected `BlueprintAgendaAssertClear` (manifest wires `AgendaSessionWakeup.assertClear`) because agenda dynamically imports `../blueprint` for wakeup instructions and a static reverse edge would close a product-layer cycle (same pattern as S3's `TerminalHookDeliverer`).

## Alternatives considered

- **Register the prompt block as the `"blueprint"` contribution's `buildSystem`** — rejected: invoke.ts's blueprint block keys off `session.blueprint`, not `workflow.kind`, so the H2 kind dispatch cannot reach it; forcing it through the registry would need a second dispatch axis for one domain. invoke.ts keeps a static prompt.ts import until the L1 exit of `session→blueprint` is owned by a later slice (S8/S9 context work).
- **Move `review-access.ts` and keep `light-loop-review-access.ts` in session/** — kept as-is: both review-access modules' final home is decided by S8's ToolExecutionContext; moving light-loop's now would churn S3's already-committed seams for no edge gain.
- **Dynamic-import the agenda guard inside the stop tool** — rejected: a lazy edge is still an edge the analyzer tracks, and eager failure at stop time with a clear wiring error beats a first-call latency hit on the loop-stop path.

## Consequences

- Product-layer pairs drop by two (`plugin→blueprint`, `blueprint→agenda` via the injected guard); `plugin/lifecycle.ts` no longer statically imports any workflow domain.
- Net L1→product stays 47: `tool→blueprint` is removed (builtin array cleanup) but `session→blueprint` gains the review-access import — the S0 budget's S4=40 projection assumed file-granularity wins that module-granularity counting does not award; the honest accounting is recorded here rather than massaging the budget.
- Registry-asserting tests import `src/product-registration`: the golden's control-source cases, the tool registry canary (`blueprint_loop_*` available through the provider), the host-dispatch contract tests, and the new `test/blueprint/register.test.ts` canary (policy + contribution + tool provider all registered).
- Without blueprint registration, `blueprint_loop_stop` fails with a wiring error instead of silently skipping the agenda guard — the correct loud degradation for an assembly mistake.
