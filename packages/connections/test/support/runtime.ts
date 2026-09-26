import { registerChannelSessionProjects } from "../../src/channel/session-projects"
import { registerManagedProjectGuard } from "../../src/channel/managed-project-ownership"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { registerConfig } from "../../src/config-schema"

export function testRuntime(options: { register?: () => void; env?: Record<string, string | undefined> } = {}) {
  return harnessRuntime({
    env: options.env,
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerChannelSessionProjects()
        registerManagedProjectGuard()
        options.register?.()
      },
    },
  })
}
