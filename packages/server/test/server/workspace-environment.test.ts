import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"
import { registerHttp } from "../../src/http"

test("HTTP file operations use logical Workspace generations for dormant and live views", async () => {
  let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  await using runtime = await testRuntime(undefined, () => {
    registerHttp()
    host = EnvironmentOrigin.registerHost("workspace-http-fixture")
    WorkspaceBlobs.register("fixture", {
      put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
      get: (hash) => Storage.readBinary(["fixture", hash]),
    })
  })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const environment = await Environment.bind({ scopeID: "home", ownerID: "owner", provider: "native", spec: {} })
    const reference = {
      scopeID: "home",
      workspaceID: workspace.id,
      workspaceGeneration: String(workspace.binding.generation),
    }
    const request = (endpoint: string, params: Record<string, string> = {}, body?: unknown) =>
      Server.App().request(
        `/workspace/files/${endpoint}?${new URLSearchParams({ ...reference, ...params })}`,
        body === undefined
          ? undefined
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      )
    for (const live of [false, true]) {
      if (!host) throw new Error("Workspace HTTP fixture Host was not composed")
      await using resources = await EnvironmentResources.resolve({
        ...reference,
        origin: host.capture(live ? "live-files" : "dormant-files"),
        workspaceGeneration: workspace.binding.generation,
        environmentID: environment.id,
        needs: live ? { execution: "exec" } : { workspace: true },
      })
      const filename = live ? "live.txt" : "dormant.txt"
      const write = await request("write", {}, { path: filename, content: "searchable 中文", expectedVersion: null })
      expect(write.status).toBe(200)
      expect(
        (await (await request("children")).json()).children.map((entry: { path: string }) => entry.path),
      ).toContain(filename)
      const read = await request("read", { path: filename })
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({ kind: "text", content: "searchable 中文" })
      const search = await request("search", { kind: "content", query: "中文" })
      expect(search.status).toBe(200)
      expect((await search.json()).items.map((entry: { path: string }) => entry.path)).toContain(filename)
      const conflict = await request("write", {}, { path: filename, content: "stale", expectedVersion: null })
      expect(conflict.status).toBe(409)
      expect((await conflict.json()).name).toBe("WorkspaceFileWriteConflictError")
      expect((await request("write", {}, { path: ".env", content: "protected", expectedVersion: null })).status).toBe(
        403,
      )
      expect((await request("read", { path: "../outside" })).status).toBe(403)
      expect((await request("read", { path: filename, workspaceGeneration: "999" })).status).toBe(409)
      expect((await Environment.get(environment.id, "home")).state).toBe(live ? "ready" : "idle")
    }
    await Environment.deallocate(environment.id, { scopeID: "home" })
  })
}, 30_000)
