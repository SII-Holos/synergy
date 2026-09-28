import { registerPluginStartup } from "../../src/plugin/startup"
import { registerPluginSkillSource } from "../../src/plugin/skill-source"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import path from "node:path"

export function testRuntime(options: { home?: string; register?: () => void } = {}) {
  return harnessRuntime({
    home: options.home,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        registerConfig()
        registerPluginStartup()
        registerPluginSkillSource()
        options.register?.()
      },
    },
  })
}
