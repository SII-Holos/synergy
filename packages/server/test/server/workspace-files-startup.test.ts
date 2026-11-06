import { expect, test } from "bun:test"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

test("file browsing starts Workspace resources without waiting for Scope recovery; writes retain the barrier", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let workspaceReady = false
  let scopeDisposed = false
  await using runtime = await testRuntime(undefined, () => {
    ScopeStartup.register({
      name: "held-scope-recovery",
      phase: "core",
      after: ["session-pause-reconcile"],
      async init() {
        entered.resolve()
        await release.promise
      },
      dispose() {
        scopeDisposed = true
      },
    })
    ScopeStartup.register({
      name: "file-resource-ready",
      phase: "surface",
      owner: "workspace",
      after: ["file-watcher"],
      init() {
        workspaceReady = true
      },
    })
  })
  await runtime.run(async () => {
    await using fixture = await tmpdir({
      git: true,
      init: (directory) => Bun.write(`${directory}/readable.txt`, "file contents"),
    })
    const scope = await fixture.scope()
    const workspace = (await WorkspaceBinding.adopt({ type: "main", path: fixture.path, scopeID: scope.id }, scope.id))!
    const query = new URLSearchParams({
      scopeID: scope.id,
      workspaceID: workspace.id!,
      workspaceGeneration: String(workspace.generation),
    })
    const app = Server.App()
    const browse = app.request(`/workspace/files/children?${query}`)
    try {
      await entered.promise
      const response = await Promise.race([
        browse,
        Bun.sleep(1_000).then(() => {
          throw new Error("file browsing waited for unrelated Scope recovery")
        }),
      ])
      expect(response.status).toBe(200)
      expect((await response.json()).children.some((item: { path: string }) => item.path === "readable.txt")).toBe(true)
      expect(workspaceReady).toBe(true)
      const write = Promise.resolve(
        app.request(`/workspace/files/directory?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "created" }),
        }),
      )
      expect(await Promise.race([write.then(() => "completed"), Bun.sleep(25).then(() => "pending")])).toBe("pending")
      release.resolve()
      expect((await write).status).toBe(200)
      await ScopeRuntime.dispose(scope.id)
      expect(scopeDisposed).toBe(true)
    } finally {
      release.resolve()
      await browse
      await ScopeRuntime.dispose(scope.id)
    }
  })
})
