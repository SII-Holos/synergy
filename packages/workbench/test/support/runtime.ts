import { registerProjectSessionHealth } from "../../src/project/session-health"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { registerConfig } from "../../src/config-schema"
import { registerWorkbenchAgents } from "../../src/agents"

export function testRuntime() {
  return harnessRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerProjectSessionHealth()
        registerWorkbenchAgents()
      },
    },
  })
}
