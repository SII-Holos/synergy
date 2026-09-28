import { expect, test } from "bun:test"
import { EnvironmentResources } from "../../src/environment/resources"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Environment } from "../../src/environment"
import { EnvironmentProviders } from "../../src/environment/provider"
import { testRuntime } from "../support/runtime"

test("API and dormant object-file requirements do not allocate an Environment", async () => {
  let allocated = 0
  await using runtime = await testRuntime({
    register() {
      EnvironmentProviders.register({
        id: "fixture",
        async allocate(request) {
          allocated++
          return { id: request.requestID, capabilities: [] }
        },
        async inspect() {
          return { state: "absent" }
        },
        async deallocate() {},
      })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "fixture", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    await using api = await EnvironmentResources.resolve({
      scopeID: "scope",
      environmentID: environment.id,
      workspaceID: "missing",
      needs: {},
    })
    expect(api.kind).toBe("none")
    await using files = await EnvironmentResources.resolve({
      scopeID: "scope",
      environmentID: environment.id,
      workspaceID: workspace.id,
      needs: { workspace: true },
    })
    expect(files.kind).toBe("objects")
    expect(files.workspace?.id).toBe(workspace.id)
    expect(allocated).toBe(0)
    expect(await Environment.uses(environment.id)).toEqual([])
    await expect(
      EnvironmentResources.resolve({ scopeID: "scope", environmentID: null, needs: { execution: "exec" } }),
    ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
    expect(allocated).toBe(0)
  })
})
