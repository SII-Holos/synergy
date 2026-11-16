# Decision Record: Compose explicit native owners for preset acceptance

Status: implemented

## Problem

Controlled acceptance observers use Resources and Execution alongside actual model-driven Sessions. Requiring native origins exposes their missing Host ownership. Registering an owner after startup is sealed, copying the full component graph or manufacturing a Session would misrepresent that control work.

## Decision

`PresetRuntimeHandle` accepts typed `additionalComponents` beside its canonical component list for task and HTTP embedding. The normal component resolver, feature selection and registration lifecycle select these declarations before registration seals.

The acceptance owner contributes one explicit component that registers the `acceptance-controller` Host. `acceptanceRuntime` selects it before opening and returns its opaque origin capture function. The separately launched remote observer selects that same component factory. Controlled resource reads, allocation fault probes and direct executions use the owning Runtime's port; cycle-history preparation receives its actual captured origin. Model-driven tools continue through their canonical Session/Run/tool origins.

## Alternatives considered

**Register an owner when a scenario first acquires resources.** Registration has already sealed and this obscures the selected native capabilities.

**Copy full product composition into the acceptance helper.** Its selected owners could drift from the product being exercised. Additional declarations pass through the existing canonical list instead.

**Create a Session to label controlled work.** A Session ID alone does not supply the original Run, message, tool call or actor and would misattribute the observer's effects.

## Consequences

Embedded hosts may select additional trusted native components explicitly. Acceptance observer ownership is independent of model task evidence; successful observer setup is not model validation or full live remote acceptance. Live provider and Docker scenarios retain their opt-in settings and independent evidence requirements.

## Verification

`test/server/runtime-additional-components.test.ts` opens both real embedding modes, refuses late registration and confirms an owner-authorized acquisition reaches the original provider fault once. `test/acceptance/runtime.test.ts` opens the actual acceptance helper, checks its opaque Host provenance in canonical Use records and verifies no model request was made. Presets typechecking includes every acceptance script; current Resources, Execution and Use inputs remain required.
