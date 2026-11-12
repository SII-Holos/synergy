import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { registerHttp } from "../../src/http"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

test("Workspace HTTP requests retain their original origin and browse dormant files without compute", async () => {
  const observed: (Readonly<EnvironmentOrigin.Current> | undefined)[] = []
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  let allocations = 0
  await using runtime = await testRuntime(undefined, () => {
    registerHttp()
    host = EnvironmentOrigin.registerHost("http-origin-fixture")
    EnvironmentProviders.register({
      id: "http-origin-fixture",
      async allocate(request) {
        allocations++
        return { id: request.requestID, capabilities: [] }
      },
      async inspect() {
        return { state: "absent" }
      },
      async deallocate() {},
    })
    WorkspaceBlobs.register("http-origin-fixture", {
      put: (hash, bytes) => Storage.writeBinary(["http-origin-fixture", hash], bytes),
      get: (hash) => {
        observed.push(EnvironmentResources.current()?.origin?.value)
        return Storage.readBinary(["http-origin-fixture", hash])
      },
    })
  })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "http-origin-fixture" } },
    })
    const environment = await Environment.bind({
      scopeID: "home",
      ownerID: "owner",
      provider: "http-origin-fixture",
      spec: {},
    })
    const selection = {
      scopeID: "home",
      workspaceID: workspace.id,
      workspaceGeneration: workspace.binding.generation,
      environmentID: environment.id,
    }
    await WorkspaceContent.write(selection, {
      path: "file.txt",
      data: new TextEncoder().encode("original bytes"),
      expectedVersion: null,
    })
    const query = new URLSearchParams({
      ...selection,
      workspaceGeneration: String(selection.workspaceGeneration),
      path: "file.txt",
    })
    const request = () => Server.App().request(`/workspace/files/read?${query}`)
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: "text", content: "original bytes" })
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every((origin) => origin?.kind === "host" && origin.owner === "http-workspace")).toBe(true)
    expect(allocations).toBe(0)
    expect((await Environment.get(environment.id, "home")).state).toBe("idle")
    expect(await Environment.uses(environment.id)).toEqual([])
    expect((await WorkspaceCatalog.get(workspace.id, "home")).activeMount).toBeUndefined()

    if (!host) throw new Error("Fixture Host was not composed")
    await using resources = await EnvironmentResources.resolve({
      ...selection,
      origin: host.capture("original-request"),
      needs: { workspace: true },
    })
    observed.length = 0
    const inherited = await EnvironmentResources.provide(resources, "original-request", request)
    expect(inherited.status).toBe(200)
    expect(await inherited.json()).toMatchObject({ kind: "text", content: "original bytes" })
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every((origin) => origin === resources.origin?.value)).toBe(true)

    observed.length = 0
    const rejected = await EnvironmentResources.provide({ ...resources, origin: undefined }, "missing-origin", request)
    expect(rejected.status).toBe(500)
    expect(observed).toEqual([])
    expect(allocations).toBe(0)
  })
})
