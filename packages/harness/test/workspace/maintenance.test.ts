import { expect, test } from "bun:test"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceOperations } from "../../src/workspace/operations"
import { testRuntime } from "../support/runtime"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "workspace-maintenance",
}

test("maintenance rejects new Workspace mutations before immutable staging while exact accepted receipts remain readable", async () => {
  let uploads = 0
  const blobs: BlobStore = {
    async put(hash, bytes) {
      uploads++
      await Storage.writeBinary(["maintenance_blobs", hash], bytes)
    },
    get: (hash) => Storage.readBinary(["maintenance_blobs", hash]),
  }
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
      WorkspaceBlobs.register("maintenance-fixture", blobs)
    },
  })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "maintenance-fixture" } },
    })
    const input = {
      id: "accepted-write",
      scopeID: workspace.scopeID,
      workspaceID: workspace.id,
      path: "accepted.txt",
      data: new TextEncoder().encode("accepted"),
      expectedVersion: null,
    }
    const original = await WorkspaceOperations.write(input)
    const head = (await WorkspaceCatalog.get(workspace.id, workspace.scopeID)).content
    const before = uploads
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    try {
      expect(await WorkspaceOperations.write(input)).toEqual(original)
      await expect(WorkspaceOperations.write({ ...input, id: "new-write", path: "new.txt" })).rejects.toMatchObject({
        name: "RuntimeMaintenanceBlocked",
      })
      expect(uploads).toBe(before)
      expect((await WorkspaceCatalog.get(workspace.id, workspace.scopeID)).content).toEqual(head)
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      expect(await WorkspaceOperations.write(input)).toEqual(original)
    } finally {
      await RuntimeMaintenance.release(lease)
    }
  })
}, 15_000)

test("maintenance waits for actual Workspace preparation and prevents its unadmitted head from publishing after the hold", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let held = true
  const blobs: BlobStore = {
    async put(hash, bytes) {
      if (held) {
        entered.resolve()
        await finish.promise
      }
      await Storage.writeBinary(["maintenance_blobs", hash], bytes)
    },
    get: (hash) => Storage.readBinary(["maintenance_blobs", hash]),
  }
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
      WorkspaceBlobs.register("maintenance-fixture", blobs)
    },
  })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "maintenance-fixture" } },
    })
    const writing = WorkspaceOperations.write({
      id: "preparing-write",
      scopeID: workspace.scopeID,
      workspaceID: workspace.id,
      path: "pending.txt",
      data: new TextEncoder().encode("pending"),
      expectedVersion: null,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await entered.promise
    const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
    const draining = RuntimeMaintenance.drain(lease)
    try {
      expect(await Promise.race([draining.then(() => "drained"), Bun.sleep(30).then(() => "pending")])).toBe("pending")
    } finally {
      held = false
      finish.resolve()
      await writing
    }
    const result = await writing
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ name: "RuntimeMaintenanceBlocked" })
    await RuntimeMaintenance.freeze(lease, await draining)
    expect((await WorkspaceCatalog.get(workspace.id, workspace.scopeID)).content).toEqual(workspace.content)
    expect(await Storage.count({ prefix: ["workspace_operation"] })).toBe(0)
    await RuntimeMaintenance.release(lease)
  })
}, 15_000)
