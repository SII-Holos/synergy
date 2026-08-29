# Decision Record: Light Loop vertical slice — lifecycle hooks in the prompt registry, acyclic domain split

Status: implemented

## Problem

The Light Loop workflow lived inside harness-core directories: three runtime modules under `session/` (light-loop-continuation, light-loop-runtime, light-loop-terminal-hook) and three tool modules under `tool/` (loop-stop, light-loop-approve, light-loop-reject), statically imported by the core loop (`invoke.ts` inlined the `<light-loop-context>` system block and dynamically imported LightLoopRuntime for loop-error conversion), by `SessionWorkflowService.cancelLightloop`, and by the builtin tool array. This was inversion points P1/P3/P5/P6 applied to the lightloop kind, plus the plugin lifecycle reattach call (`plugin/lifecycle.ts` → LightLoopRuntime.reattachPluginTimers) listed as S3 scope.

## Decision

Move the Light Loop domain to `src/light-loop/` (continuation.ts, runtime.ts, terminal-hook.ts, tools/) and attach through registries loaded by the L4 product manifest:

- **Move**: `session/light-loop-{continuation,runtime,terminal-hook}.ts` → `src/light-loop/`; `tool/{loop-stop,light-loop-approve,light-loop-reject}.{ts,txt}` → `src/light-loop/tools/`. `session/light-loop-state.ts` stays in L1: it is a pure predicate over the persisted workflow union (the persisted-projection narrowing base), not domain behavior. `session/light-loop-review-access.ts` stays until S8's ToolExecutionContext.
- **H1 continuation**: `registerLightLoopDomain()` registers `LightLoopContinuationPolicy` under `"lightloop"`; its legacy-bridge line is deleted from the product manifest.
- **H2 prompts + lifecycle**: `WorkflowPromptRegistry.Contribution` gains optional lifecycle hooks — `onLoopError(sessionID, error)` (replaces invoke.ts's dynamic LightLoopRuntime import after loop errors), `cancel(sessionID)` (replaces `SessionWorkflowService.cancelLightloop`'s body; the method remains as the locked public surface delegating to the registry), and `reattachPluginTimers()`. The lightloop contribution carries the system-context block, the agent-specific user-message wrappers, and the cancel/onLoopError implementations; invoke.ts and WorkflowUserWrapper query the registry for kind `"lightloop"`.
- **Plugin reload**: `plugin/lifecycle.ts` replaces its direct LightLoopRuntime import with `reattachWorkflowTimers()`, which fans out to `reattachPluginTimers` across registered prompt contributions (BlueprintLoop stays as an explicit call until S4).
- **Acyclic domain split**: moving runtime.ts out of session/ would have created a new product-layer cycle (`light-loop→plugin` via `Plugin.deliverHookForPlugin`, `plugin→light-loop` via host-services). The terminal-hook delivery is now an injected `TerminalHookDeliverer` (`setTerminalHookDeliverer`), wired in the L4 product manifest to `Plugin.deliverHookForPlugin`. The plugin→light-loop host-services direction remains an allowed one-way composition edge; light-loop no longer imports plugin.
- **Host services**: `plugin/host-services.ts` start/get/cancelLightLoop keep living in the plugin domain (they are plugin-permission surfaces) and import from the new domain location.

Verification: S3a byte-exact golden for the three agent wrapper variants; lightloop suites (continuation, runtime, review tools, loop-stop, host-service, workflow routes, kernel, wrapper) all green with product-manifest wiring; typecheck clean; snapshot ratchet coherent with zero R3 violations and the plugin↔light-loop cycle broken in the same commit.

## Alternatives considered

- **Keep state.ts and review-access.ts in session/ temporarily** — accepted as stated: state.ts is arguably core (persisted-union predicate used by recovery/working), and review-access's fate is decided by S8's ToolExecutionContext; moving them twice would churn the same import sites.
- **Move the lightloop host-service functions into the light-loop domain with a registry dispatch** — deferred: host-services is the plugin permission surface (reads manifests, enforces capabilities); relocating it changes the security-review surface mid-slice. The one-way edge is inside the R3 baseline.
- **Event-bus based timer reattach** — rejected for now: `reattachPluginTimers` is an await-ordered startup step (plugin init must complete before timers reattach); a Bus subscription would reorder it. The registry fan-out preserves ordering with the same inversion effect.

## Consequences

- `session/` and `tool/` no longer contain lightloop runtime or tool code; the lightloop attachment points (kernel policy, Layer 2.5 block, user wrappers, loop-error conversion, cancel, timer reattach) are all registry-mediated.
- Registry-asserting tests import `src/product-registration` (light-loop golden, workflow-route, boss tools, kernel) — the same contract as production entries.
- Without light-loop registration, lightloop user messages pass through unwrapped and cancelLightloop becomes a no-op returning the session — the correct degradation when the domain is absent.
- The injected hook deliverer records a durable delivery error when registration is missing, so plugin-owned terminal hooks never silently vanish in direct-invoke paths that bypass the manifest.
