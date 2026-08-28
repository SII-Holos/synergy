# Decision Record: Product-layer cycle clearance and layering gate promotion

Status: implemented

## Problem

After the L1 inversions, dependency-cruiser still reported fifteen `r2-product-acyclic` file-level cycles across eight cycle groups (plugin↔cortex cross-domain, a plugin-internal lifecycle ring, lattice controller↔run-service, holos runtime↔mailbox, browser runtime↔command-service, blueprint loop-runtime↔loop-store, agenda bootstrap↔index, channel index↔question-card-bridge, and a command↔project type-only edge). R1/R2 gates could not be promoted to error severity with these present, and the product layer's module SCC (SCC(20)+SCC(2)) still merged most product domains into one component.

## Decision

Break every cycle at its owning layer, byte-equal behavior:

- **Cross-domain (cortex↔plugin)**: both directions now flow through the existing L1 ports — `cortex/manager.ts` fires the `cortex.task.after` hook via `SessionPluginHooks.triggerForPlugin` (the public wrapper already existed); `plugin/host-services-runtime.ts` reads task info and wait states via two new `SessionCortexRuntime.Provider` methods (`taskInfo`, `waitForTask`) implemented by the cortex session-runtime adapter.
- **Domain-internal rings** use registered setter injection inside the owning domain (the `setTerminalHookDeliverer` precedent), never new L1 registries: plugin lifecycle hooks (`setHostServiceLifecycleHooks`), lattice reconcile forwarding (`LatticeRunService.setReconcileDirect`, keeping a one-way controller→run-service edge), the holos provider resolver (`setHolosProviderResolver`), and the browser command executor (`registerBrowserCommandExecutor`).
- **Leaf extraction** where the ring is accidental coupling: blueprint deadline timers moved to a zero-dependency `blueprint/deadline.ts` consumed by both loop-runtime and loop-store; the channel provider registry moved to `channel/provider-registry.ts` (the `Channel.getProvider`/`registerProvider` namespace surface is unchanged); agenda bootstrap left the barrel re-export (the single consumer imports it directly).
- **Type-only edge**: `project/worktree-command.ts` mirrors the `Command.Result` shape as a local structural interface instead of importing across the command↔project boundary.
- **Gates promoted**: R1 (L1 must not import product or assembly) and R2 (product acyclic) are now `error` severity in `.dependency-cruiser.cjs`; R1's `to` pattern was extended to cover the assembly directories (`server`, `cli`, `daemon`, `runtime`) so both cleared boundaries stay closed.

## Alternatives considered

- **New L1 registries for every setter** — rejected: these rings are product-internal wiring; L1 ports exist for cross-layer inversion only, and each new registry would widen the L1 surface for no consumer.
- **Keeping the rings as a documented baseline** — rejected: the Blueprint's acceptance criteria require R2 at error severity.
- **Merging lattice controller and run-service into one module** — rejected: they are separately consumed (server routes import run-service directly); the registered forwarder keeps the one-way edge with byte-equal call semantics.

## Consequences

- `bun run deps:check`: zero r2 violations; 0 errors, 15 warnings — all unchanged `r4-l0-core-uplift-baseline` entries (L0→L1 uplift, tracked for later).
- `bun run deps:analyze`: L1→product 0, L1→assembly 0, R3 0, product pairs 39. The module SCC graph is now SCC(25) (core layer: L1+L0) and SCC(18) (product+assembly) — no L1 module shares a component with any product module; the historical SCC(53) is fully decomposed. cortex and browser left the product component; the command/project SCC(2) dissolved.
- Registration timing became load-sensitive for three test files that bypass the domain load chain (lattice-route, browser runtime-lifecycle, plugin task-run); they now import the registering module or the product manifest explicitly — the same mounting convention as every other registry test.
- Two baseline failures remain outside this change (stash-verified on a clean tree): one cortex dag-result assertion and three project worktree-route tests.

## Follow-up: module-level decomposition (S10c)

The review round rejected the file-level-only end state: the module graph still closed SCC(18) through pure-product module pairs (agenda→blueprint→plugin→light-loop→agenda among them). Nine further cuts decomposed every product-containing module component to zero:

- **L0 extraction**: `channel/identity.ts`, `server/runtime-endpoint.ts`, and `cli/ui.ts` moved to `util/` (each zero upper-layer imports; ui turned out to have 37 relative importers inside cli/cmd, all mechanically repointed).
- **Domain relocation**: `remote/holos-transport.ts` → `holos/synergy-link-transport.ts` (the transport adapts Holos to the remote client; holos→remote stays one-way via the client import). `plugin/agent-call-runtime.ts` and `plugin/runtime-limits.ts` moved to `plugin-runtime/`, dissolving the plugin↔plugin-runtime two-cycle.
- **Kit-direct import**: mcp reads `PluginId` from `@ericsanchezok/synergy-plugin/ids` instead of `plugin/ids.ts`.
- **Adapter slot**: plugin reaches light-loop only through `PluginLightLoopAdapter` (host-services slot mirroring the blueprint adapter). One deviation from the mirrored precedent was necessary: the adapter registers at the bottom of `plugin/host-services.ts` itself (module-load registration), not from `light-loop/register.ts`, because the R3 snapshot baseline contains `plugin→light-loop` but not `light-loop→plugin` — the blueprint precedent only worked because `blueprint→plugin` happened to be in the baseline. Registering in the other direction would have manufactured a new R3 pair.
- **Setter injection**: light-loop's loop-stop receives the agenda assert-clear through `setLightLoopAgendaAssertClear`, wired in the product manifest.

Final state: `bun .analysis/full-scc-edges.ts` prints nothing (no SCC contains a product module); product pairs 39→34; `deps:check` unchanged at 0 errors / 15 pre-existing r4-l0 uplift warnings. Cross-domain file moves keep their original import specifier form (`@/` alias vs relative) because dependency-cruiser resolves only relative paths — rewriting an alias to relative can expose a previously invisible same-module ring.
