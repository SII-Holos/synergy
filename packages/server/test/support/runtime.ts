import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import path from "node:path"

export function testRuntime(env?: Record<string, string | undefined>, register?: () => void) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        register?.()
      },
    },
  })
}
