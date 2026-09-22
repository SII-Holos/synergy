import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Server } from "../../src/server/server"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function url(scopeID: string, workspace: { id?: string; generation?: number }, endpoint = "read") {
  return `/workspace/files/${endpoint}?${new URLSearchParams({
    scopeID,
    workspaceID: workspace.id!,
    workspaceGeneration: String(workspace.generation),
    path: "same.txt",
  })}`
}

test("file requests select a Workspace inside their Scope, including Home", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await Bun.write(path.join(first.path, "same.txt"), "first")
    await Bun.write(path.join(second.path, "same.txt"), "second")
    const scope = await first.scope()
    const a = (await WorkspaceBinding.adopt({ type: "directory", path: first.path, scopeID: scope.id }, scope.id))!
    const b = (await WorkspaceBinding.adopt({ type: "directory", path: second.path, scopeID: scope.id }, scope.id))!
    const app = Server.App()
    for (const [workspace, content] of [
      [a, "first"],
      [b, "second"],
    ] as const) {
      const response = await app.request(url(scope.id, workspace))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ content })
    }
    const foreign = await app.request(url(Scope.home().id, a))
    expect(foreign.status).toBe(404)
    const home = (await WorkspaceBinding.adopt({ type: "directory", path: second.path, scopeID: "home" }, "home"))!
    const response = await app.request(url("home", home))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ content: "second" })
  }))

test("missing selection and stale generations cannot fall back to the main directory", () =>
  runtime.run(async () => {
    await using main = await tmpdir()
    await using target = await tmpdir()
    await Bun.write(path.join(main.path, "same.txt"), "main")
    await Bun.write(path.join(target.path, "same.txt"), "target")
    const scope = await main.scope()
    const workspace = (await WorkspaceBinding.adopt(
      { type: "directory", path: target.path, scopeID: scope.id },
      scope.id,
    ))!
    const app = Server.App()
    expect((await app.request(`/workspace/files/read?scopeID=${scope.id}&path=same.txt`)).status).toBe(400)
    const stale = await app.request(url(scope.id, { ...workspace, generation: workspace.generation! + 1 }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ name: "WorkspaceBindingChanged" })
    await fs.rm(target.path, { recursive: true })
    const missing = await app.request(url(scope.id, workspace))
    expect(missing.status).toBe(409)
    expect(await missing.json()).toMatchObject({ name: "WorkspaceUnavailable" })
  }))

test("raw documents keep Workspace generation in relative-resource URLs", () =>
  runtime.run(async () => {
    await using main = await tmpdir()
    await using target = await tmpdir()
    await Bun.write(path.join(target.path, "page.html"), '<img src="image.txt">')
    await Bun.write(path.join(target.path, "image.txt"), "workspace-image")
    const scope = await main.scope()
    const workspace = (await WorkspaceBinding.adopt(
      { type: "directory", path: target.path, scopeID: scope.id },
      scope.id,
    ))!
    const prefix = `/workspace/files/raw/${Buffer.from(scope.id).toString("base64url")}/${workspace.id}/${workspace.generation}/`
    const app = Server.App()
    const response = await app.request(prefix + "page.html")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
    const asset = new URL("image.txt", `http://synergy.test${prefix}page.html`)
    expect(await (await app.request(asset.pathname)).text()).toBe("workspace-image")
    const record = await WorkspaceCatalog.get(workspace.id!, scope.id)
    await WorkspaceCatalog.rebind(record.id, {
      scopeID: scope.id,
      expectedRevision: record.revision,
      hostID: record.binding.hostID,
      path: workspace.path,
      physicalID: record.binding.physicalID,
    })
    const stale = await app.request(prefix + "image.txt")
    expect(stale.status).toBe(409)
  }))

test("registering and selecting a directory Workspace keeps its owning Scope", () =>
  runtime.run(async () => {
    await using main = await tmpdir()
    await using target = await tmpdir()
    const scope = await main.scope()
    const app = Server.App()
    const response = await app.request(`/workspace?scopeID=${scope.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target.path }),
    })
    expect(response.status).toBe(200)
    const workspace = WorkspaceCatalog.Info.parse(await response.json())
    expect(workspace).toMatchObject({ scopeID: scope.id, type: "directory", binding: { state: "bound" } })
    const listing = await app.request(`/workspace?scopeID=${scope.id}`)
    expect(listing.status).toBe(200)
    expect(await listing.json()).toContainEqual(workspace)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create()
        const selected = await Session.applyWorkspaceSelection(session.id, {
          mode: "workspace",
          workspaceID: workspace.id,
          workspaceGeneration: workspace.binding.generation,
        })
        expect(selected.scope.id).toBe(scope.id)
        expect(selected.workspaceID).toBe(workspace.id)
        expect(selected.workspace?.path).toBe(target.path)
      },
    })
  }))

test("Workspace sharing, rebinding and Session selection are conditional Scope-owned API operations", () =>
  runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    const scope = await a.scope()
    const first = await WorkspaceBinding.register(scope.id, a.path)
    const second = await WorkspaceBinding.register(scope.id, b.path)
    const app = Server.App()
    const mutate = (endpoint: string, body: unknown) =>
      app.request(`${endpoint}?scopeID=${scope.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const shared = await mutate(`/workspace/${first.id}/sharing`, {
      expectedRevision: first.revision,
      workspaceIDs: [second.id],
    })
    expect(shared.status).toBe(200)
    expect(await shared.json()).toMatchObject({
      sharedWritableWorkspaceIDs: [second.id],
      binding: { generation: first.binding.generation },
    })
    expect(
      (await mutate(`/workspace/${first.id}/sharing`, { expectedRevision: first.revision, workspaceIDs: [] })).status,
    ).toBe(409)
    const rebound = await mutate(`/workspace/${second.id}/rebind`, { expectedRevision: second.revision, path: c.path })
    expect(rebound.status).toBe(200)
    const record = WorkspaceCatalog.Info.parse(await rebound.json())
    expect(record.binding.path).toBe(c.path)
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const selected = await mutate(`/session/${session.id}/workspace`, {
      mode: "workspace",
      workspaceID: second.id,
      workspaceGeneration: record.binding.generation,
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({
      workspaceID: second.id,
      scope: { id: scope.id },
      workspace: { path: c.path },
    })
    expect(
      (
        await mutate(`/session/${session.id}/workspace`, {
          mode: "workspace",
          workspaceID: second.id,
          workspaceGeneration: second.binding.generation,
        })
      ).status,
    ).toBe(409)
    const cleared = await mutate(`/session/${session.id}/workspace`, { mode: "none" })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ workspace: null, workspaceID: null })
  }))
