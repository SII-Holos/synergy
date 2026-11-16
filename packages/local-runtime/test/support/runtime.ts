import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "../../src/register"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"

export async function testRuntime(
  options: {
    home?: string
    env?: Record<string, string | undefined>
    register?: () => void
    postgres?: string
    workspaceCoordinator?: WorkspaceCoordinator
  } = {},
) {
  const runtime = await harnessRuntime({
    home: options.home,
    env: options.env,
    register: options.register,
    postgres: options.postgres,
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: options.workspaceCoordinator ?? testWorkspaceCoordinator(),
        })
      },
    },
  })
  try {
    await runtime.run(async () => {
      const key = ["storage_meta", "identity"],
        [existing] = await Storage.readMany([key])
      if (existing !== undefined) {
        StorageBootstrap.DatasetIdentity.parse(existing)
        return
      }
      // Manually owned test stores bypass Bootstrap and must supply their actual dataset header.
      await Storage.write(
        key,
        StorageBootstrap.DatasetIdentity.parse({ storeID: crypto.randomUUID(), artifactStoreID: crypto.randomUUID() }),
      )
    })
    return runtime
  } catch (error) {
    await runtime.close()
    throw error
  }
}

export function testWorkspaceCoordinator() {
  return new WorkspaceCoordinator({ directory: path.join(RuntimeContext.current().host.root, "claims") })
}
