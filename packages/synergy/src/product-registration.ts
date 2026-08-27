/**
 * L4 product manifest: the single static list through which built-in product
 * domains attach to the harness core. Every real entry point loads this module
 * (main.ts for CLI commands, server/runtime.ts for the server and daemon
 * process), so product registrations are present before any core registry is
 * consumed.
 *
 * Current scope: product-domain migrations (S1) and the boss domain (S2).
 * The legacy block registers continuation policies for domains whose vertical
 * slices (S3–S5) have not moved their files out of session/ and lattice/ yet;
 * each slice deletes its entry here.
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
import { ContinuationKernel } from "./session/continuation-kernel"
import { BlueprintContinuationPolicy } from "./session/blueprint-continuation"
import { LightLoopContinuationPolicy } from "./session/light-loop-continuation"
import { LatticeContinuationPolicy } from "./lattice/policy"

registerBossDomain()

// Legacy bridge: policies for domains not yet migrated to their own register
// module. Removed by S3 (light-loop), S4 (blueprint), S5 (lattice).
ContinuationKernel.registerProvider("blueprint", () => [BlueprintContinuationPolicy])
ContinuationKernel.registerProvider("lightloop", () => [LightLoopContinuationPolicy])
ContinuationKernel.registerProvider("lattice", () => [LatticeContinuationPolicy])
