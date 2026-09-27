import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("resource APIs select logical files and execution independently without starting compute", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Config.updateGlobal({
      resources: { defaultEnvironment: null, stores: { files: { provider: "local", spec: { namespace: "test" } } } },
    })
    const request = (route: string, body?: unknown) =>
      Server.App().request(
        `${route}?scopeID=home`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      )
    const profiles = await request("/environment/profiles")
    expect(profiles.status).toBe(200)
    expect(await profiles.json()).toMatchObject({
      defaultEnvironment: null,
      stores: [{ name: "files", provider: "local" }],
    })
    const workspaceResponse = await request("/workspace/objects", { profile: "files", name: "Research" })
    expect(workspaceResponse.status).toBe(200)
    const workspace = await workspaceResponse.json()
    const environmentResponse = await request("/environment", { profile: "native", requestID: "test-creation" })
    expect(environmentResponse.status).toBe(200)
    const environment = await environmentResponse.json()
    const duplicate = await request("/environment", { profile: "native", requestID: "test-creation" })
    expect((await duplicate.json()).id).toBe(environment.id)
    const created = await request("/session", {
      workspace: { mode: "workspace", workspaceID: workspace.id, workspaceGeneration: workspace.binding.generation },
      environmentID: null,
    })
    expect(created.status).toBe(200)
    const session = await created.json()
    expect(session).toMatchObject({ workspaceID: workspace.id, workspace: null, environmentID: null })
    const select = (environmentID: string | null, expectedEnvironmentID: string | null) =>
      request(`/session/${session.id}/environment`, { environmentID, expectedEnvironmentID })
    await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const busy = SessionManager.acquire(session.id)!
        try {
          expect((await select(environment.id, null)).status).toBe(409)
        } finally {
          await SessionManager.release(busy)
        }
      },
    })
    const selected = await select(environment.id, null)
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ environmentID: environment.id, workspaceID: workspace.id })
    expect((await select(null, null)).status).toBe(409)
    expect((await Environment.get(environment.id, "home")).state).toBe("idle")
    expect(await Environment.uses(environment.id)).toEqual([])
    expect((await select(null, environment.id)).status).toBe(200)
    expect(await (await request(`/environment/${environment.id}/activity`)).json()).toMatchObject({
      executions: [],
      uses: [],
      files: [],
    })
    expect((await request(`/environment/${environment.id}/release`, { expectedGeneration: 999 })).status).toBe(409)
    expect((await request("/environment", { profile: "absent", requestID: "missing-profile" })).status).toBe(404)
    expect((await request("/workspace/objects", { profile: "absent" })).status).toBe(404)
  })
})

test("recovery APIs retain unfinished ownership, enforce Scope and retry saving without executing again", async () => {
  let fail = false
  await using runtime = await testRuntime(undefined, () =>
    WorkspaceBlobs.register("fixture", {
      async put(hash, bytes) {
        if (fail) throw new Error("save unavailable")
        await Storage.writeBinary(["test_blobs", hash], bytes)
      },
      get: (hash) => Storage.readBinary(["test_blobs", hash]),
    }),
  )
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const environment = await Environment.bind({ scopeID: "home", ownerID: "test", provider: "native", spec: {} })
    const other = await Environment.bind({ scopeID: "home", ownerID: "other", provider: "native", spec: {} })
    const selection = { scopeID: "home", workspaceID: workspace.id, environmentID: environment.id }
    const resources = await EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
    const session = await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: () => Session.create({ workspaceID: workspace.id, environmentID: environment.id }),
    })
    const process = await EnvironmentProcess.prepare({
      id: "saved-once",
      scopeID: "home",
      resources,
      command: {
        command: Bun.which("bun")!,
        args: ["-e", "await Bun.write('result', 'once')"],
        cwd: resources.directory!,
        env: {},
        writableRoots: [resources.directory!],
      },
    })
    process.child.stdout.resume()
    process.child.stderr.resume()
    const completion = process.completion.catch((error: unknown) => error)
    fail = true
    await process.activate()
    expect(await completion).toMatchObject({ name: "EnvironmentProcessError" })
    await resources.release()
    const post = (route: string, body: unknown = {}, scopeID = "home") =>
      Server.App().request(`${route}?scopeID=${scopeID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const current = await Environment.get(environment.id, "home")
    expect(
      (await post(`/environment/${environment.id}/release`, { expectedGeneration: current.generation })).status,
    ).toBe(409)
    expect(
      (await post(`/session/${session.id}/environment`, { environmentID: null, expectedEnvironmentID: environment.id }))
        .status,
    ).toBe(409)
    const activity = await (await Server.App().request(`/environment/${environment.id}/activity?scopeID=home`)).json()
    expect(activity.executions).toMatchObject([{ id: "saved-once", state: "unsaved" }])
    expect((await post(`/environment/${other.id}/execution/saved-once/recover`)).status).toBe(404)
    await using foreign = await tmpdir()
    const foreignScope = await foreign.scope()
    expect(
      (await post(`/environment/${environment.id}/execution/saved-once/recover`, {}, foreignScope.id)).status,
    ).toBe(404)
    fail = false
    const recovered = await post(`/environment/${environment.id}/execution/saved-once/recover`)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ id: "saved-once", state: "completed" })
    expect((await post(`/environment/${environment.id}/execution/saved-once/recover`)).status).toBe(200)
    const switched = await post(`/session/${session.id}/environment`, {
      environmentID: null,
      expectedEnvironmentID: environment.id,
    })
    expect(switched.status).toBe(200)
    expect((await WorkspaceCatalog.get(workspace.id, "home")).activeMount).toBeUndefined()
    expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe("once")
    expect(
      (await post(`/environment/${environment.id}/release`, { expectedGeneration: current.generation })).status,
    ).toBe(200)
  })
}, 30_000)
