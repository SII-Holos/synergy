import { registerPluginStartup } from "../../src/plugin/startup"
import { registerPluginSkillSource } from "../../src/plugin/skill-source"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"

export function testRuntime(options: { home?: string } = {}) {
  return harnessRuntime({
    home: options.home,
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerPluginStartup()
        registerPluginSkillSource()
      },
    },
  })
}
