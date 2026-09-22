import { describe, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { WorkspaceCatalog } from "../../src/workspace/catalog"

describe("Workspace catalog", () => {
  test("shares one identity for a local binding without sharing another host's files", async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const input = { scopeID: "project", type: "main", hostID: "host-a", path: "/project" }
      const [first, second] = await Promise.all([WorkspaceCatalog.register(input), WorkspaceCatalog.register(input)])
      expect(second.id).toBe(first.id)
      expect((await WorkspaceCatalog.register({ ...input, hostID: "host-b" })).id).not.toBe(first.id)
      expect(await WorkspaceCatalog.list("project")).toHaveLength(2)
    })
  })

  test("rebinding preserves identity and invalidates the former generation", async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const first = await WorkspaceCatalog.register({ scopeID: "project", type: "main", hostID: "host", path: "/old" })
      const moved = await WorkspaceCatalog.rebind(first.id, {
        scopeID: "project",
        expectedRevision: first.revision,
        hostID: "host",
        path: "/new",
      })
      expect(moved.id).toBe(first.id)
      expect(moved.binding.generation).toBe(first.binding.generation + 1)
      await expect(
        WorkspaceCatalog.resolve(first.id, {
          scopeID: "project",
          hostID: "host",
          generation: first.binding.generation,
        }),
      ).rejects.toMatchObject({ name: "WorkspaceBindingChanged" })
      await expect(WorkspaceCatalog.resolve(first.id, { scopeID: "other", hostID: "host" })).rejects.toMatchObject({
        name: "NotFoundError",
      })
      await expect(WorkspaceCatalog.resolve(first.id, { scopeID: "project", hostID: "other" })).rejects.toMatchObject({
        name: "WorkspaceUnavailable",
      })
    })
  })

  test("a stale update cannot overwrite another binding", async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const first = await WorkspaceCatalog.register({ scopeID: "project", type: "main", hostID: "host", path: "/old" })
      await WorkspaceCatalog.rebind(first.id, {
        scopeID: "project",
        expectedRevision: first.revision,
        hostID: "host",
        path: "/new",
      })
      await expect(
        WorkspaceCatalog.rebind(first.id, {
          scopeID: "project",
          expectedRevision: first.revision,
          hostID: "host",
          path: "/wrong",
        }),
      ).rejects.toMatchObject({ name: "WorkspaceBindingChanged" })
      expect((await WorkspaceCatalog.get(first.id, "project")).binding.path).toBe("/new")
    })
  })
})
