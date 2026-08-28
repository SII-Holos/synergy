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
