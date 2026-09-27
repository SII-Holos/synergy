import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "../../src/register"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

export function testRuntime(
  options: { home?: string; env?: Record<string, string | undefined>; register?: () => void } = {},
) {
  return harnessRuntime({
    home: options.home,
    env: options.env,
    register: options.register,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
      },
    },
  })
}
