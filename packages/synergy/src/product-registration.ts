/**
 * L4 product manifest: the single static list through which built-in product
 * domains attach to the harness core. Every real entry point loads this module
 * (main.ts for CLI commands, server/runtime.ts for the server and daemon
 * process), so product registrations are present before any core registry is
 * consumed.
 *
 * Current scope: product-domain migrations (S1), boss domain (S2), light-loop
 * domain (S3). The legacy block registers continuation policies for domains
 * whose vertical slices (S4–S5) have not moved their files yet; each slice
 * deletes its entry here.
 */
import "./agenda/migration"
import "./blueprint/migration"
import "./browser/migration"
import "./holos/migration"
import "./lattice/migration"
import "./library/migration"
import "./note/migration"
import "./plugin/migration"

import { registerBossDomain } from "./boss/register"
import { registerLightLoopDomain } from "./light-loop/register"
import { setTerminalHookDeliverer } from "./light-loop/runtime"
import { Plugin } from "./plugin"
import { ContinuationKernel } from "./session/continuation-kernel"
import { BlueprintContinuationPolicy } from "./session/blueprint-continuation"
import { LatticeContinuationPolicy } from "./lattice/policy"

registerBossDomain()
registerLightLoopDomain()

// L4 assembly: the light-loop domain consumes plugin hook delivery through an
// injected function so product domains stay acyclic (no light-loop→plugin
// import; plugin→light-loop host-services remains the allowed direction).
setTerminalHookDeliverer((pluginId, pluginGeneration, pointName, input) =>
  Plugin.deliverHookForPlugin(pluginId, pluginGeneration, pointName, input),
)

// Legacy bridge: policies for domains not yet migrated to their own register
// module. Removed by S4 (blueprint), S5 (lattice).
ContinuationKernel.registerProvider("blueprint", () => [BlueprintContinuationPolicy])
ContinuationKernel.registerProvider("lattice", () => [LatticeContinuationPolicy])
