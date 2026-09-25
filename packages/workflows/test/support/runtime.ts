import { registerSessionSchema } from "../../src/session-schema"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"
import { registerWorkflowSessions } from "../../src/session/register"
import { registerBlueprintDomain } from "../../src/blueprint/register"
import { registerWorkflowsAgents } from "../../src/agents"
import { registerLatticeDomain } from "../../src/lattice/register"
import { registerBossDomain } from "../../src/boss/register"
import { registerLightLoopDomain } from "../../src/light-loop/register"

export function testRuntime(env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerSessionSchema()
        registerWorkflowSessions()
        registerBlueprintDomain()
        registerWorkflowsAgents()
        registerLatticeDomain()
        registerBossDomain()
        registerLightLoopDomain()
      },
    },
  })
}
