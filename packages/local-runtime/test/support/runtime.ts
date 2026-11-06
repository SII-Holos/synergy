import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "../../src/register"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

export function testRuntime(
  options: { home?: string; env?: Record<string, string | undefined>; register?: () => void; postgres?: string } = {},
) {
  return harnessRuntime({
    home: options.home,
    env: options.env,
    register: options.register,
    postgres: options.postgres,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: testWorkspaceCoordinator(),
        })
      },
    },
  })
}

export function testWorkspaceCoordinator() {
  return new WorkspaceCoordinator({ directory: path.join(RuntimeContext.current().host.root, "claims") })
}
