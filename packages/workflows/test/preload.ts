import { registerWorkflowSessions } from "../src/session/register"
registerWorkflowSessions()
import "../src/config-schema"
import { registerBlueprintDomain } from "../src/blueprint/register"
import { registerWorkflowsAgents } from "../src/agents"
registerBlueprintDomain()
registerWorkflowsAgents()
import { registerCortexSessionRuntime } from "@ericsanchezok/synergy-harness/cortex/session-runtime"
registerCortexSessionRuntime()
import { registerLatticeDomain } from "../src/lattice/register"
import { registerBossDomain } from "../src/boss/register"
import { registerLightLoopDomain } from "../src/light-loop/register"
registerLatticeDomain()
registerBossDomain()
registerLightLoopDomain()
