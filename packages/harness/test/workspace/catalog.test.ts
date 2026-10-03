import { describe, expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Storage } from "../../src/storage/storage"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { WorkspaceLocation } from "../../src/workspace/location"
import { tmpdir } from "../support/fixture"

test("missing stable volume evidence reports unverified identity and never downgrades the saved binding", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const source = WorkspaceLocation.source()
    const location = await source.identify(directory.path)
    const record = await WorkspaceCatalog.register({
      scopeID: "project",
      type: "directory",
      hostID: await source.hostID(),
      path: location.path,
      physicalID: "volume-v1:fixture-volume:inode:birth",
    })
    using inspection = spyOn(source, "identify").mockResolvedValue({
      path: location.path,
      physicalID: "device:inode:birth",
    })
    await expect(WorkspaceBinding.validate(record.id, "project")).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
      data: { reason: "identity_unverified" },
    })
    expect((await WorkspaceCatalog.get(record.id, "project")).binding).toEqual(record.binding)
    inspection.mockResolvedValue({ path: location.path, physicalID: "volume-v1:replacement-volume:inode:birth" })
    await expect(WorkspaceBinding.validate(record.id, "project")).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
      data: { reason: "identity_changed" },
    })
  })
})

describe("Workspace catalog", () => {
  test("an existing registration remains readable while the writer is occupied", async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const input = { scopeID: "project", type: "main", hostID: "host", path: "/registered", physicalID: "identity" }
      const registered = await WorkspaceCatalog.register(input)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writer = Storage.transaction(async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          WorkspaceCatalog.register(input),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Registration lookup waited for the held writer")), 2000)
          }),
        ])
        expect(result).toEqual(registered)
        await expect(WorkspaceCatalog.register({ ...input, physicalID: "replacement" })).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
      } finally {
        clearTimeout(timer)
        release.resolve()
        await writer
      }
    })
  })

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

test("missing foreign references receive canonical unbound identities and can be explicitly rebound", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const imported = await WorkspaceCatalog.importMissingReference("foreign-legacy-id", "project")
    expect(imported.id).toStartWith("wsp_")
    expect(imported.importedFrom?.workspaceID).toBe("foreign-legacy-id")
    expect(WorkspaceCatalog.projection(imported)).toBeNull()
    await expect(WorkspaceCatalog.resolve(imported.id, { scopeID: "project", hostID: "host" })).rejects.toThrow()
    const bound = await WorkspaceCatalog.rebind(imported.id, {
      scopeID: "project",
      expectedRevision: imported.revision,
      hostID: "host",
      path: "/selected",
    })
    expect(bound.binding.generation).toBe(imported.binding.generation + 1)
    expect(WorkspaceCatalog.projection(bound)?.path).toBe("/selected")
  })
})
