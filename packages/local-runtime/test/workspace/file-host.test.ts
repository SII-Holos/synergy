import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("active file host retains a mutation until its checkpoint is acknowledged and deduplicates lost responses", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  await fs.mkdir(root)
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  const host = new NativeWorkspaceFiles({
    directory: path.join(tmp.path, "receipts"),
    materializationRoot: path.join(tmp.path, "views"),
    coordinator,
  })
  const reference = { id: "mount", workspaceID: "workspace", generation: 1 }
  await host.mount({ ...reference, readOnly: false, source: { kind: "directory", path: root } })
  const input = {
    id: "write",
    mount: reference,
    path: "file",
    data: Buffer.from("saved").toString("base64"),
    expectedVersion: null,
  }
  const checkpoint = await host.write(input)
  expect(await host.write(input)).toEqual(checkpoint)
  await expect(host.write({ ...input, data: "b3RoZXI=" })).rejects.toThrow("different input")
  expect((await host.read({ mount: reference, path: "file", maximumBytes: 100 })).data).toBe(input.data)
  const waiting = coordinator.acquire({
    id: "other",
    owner: "other",
    ancestors: [],
    roots: [root],
    kind: "operation",
    timeoutMs: 20,
  })
  await expect(waiting).rejects.toThrow()
  expect(checkpoint.manifest).toBeNull()
  await host.acknowledge(input.id)
  await expect(host.write({ ...input, id: "conflict" })).rejects.toThrow("changed")
  expect((await host.checkpointStatus("conflict"))?.state).toBe("failed")
  const lease = await coordinator.acquire({
    id: "other",
    owner: "other",
    ancestors: [],
    roots: [root],
    kind: "operation",
    timeoutMs: 1000,
  })
  await lease.release()
  await expect(host.read({ mount: { ...reference, generation: 2 }, path: "file", maximumBytes: 100 })).rejects.toThrow(
    "changed",
  )
  await host.detach(reference)
  expect(await Bun.file(path.join(root, "file")).text()).toBe("saved")
})

test("closing a file host cancels queued mutations without writing after shutdown", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  await fs.mkdir(root)
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  const host = new NativeWorkspaceFiles({
    directory: path.join(tmp.path, "receipts"),
    materializationRoot: path.join(tmp.path, "views"),
    coordinator,
  })
  const mount = { id: "mount", workspaceID: "workspace", generation: 1 }
  await host.mount({ ...mount, readOnly: false, source: { kind: "directory", path: root } })
  const occupied = await coordinator.acquire({
    id: "occupied",
    owner: "occupied",
    ancestors: [],
    roots: [root],
    kind: "operation",
  })
  const writing = host.write({ id: "queued", mount, path: "never", data: "eA==", expectedVersion: null })
  void writing.catch(() => {})
  try {
    for (let i = 0; !(await host.checkpointStatus("queued")) && i < 100; i++) await Bun.sleep(5)
    await host.close()
    await expect(writing).rejects.toThrow("closing")
    expect((await host.checkpointStatus("queued"))?.state).toBe("failed")
    expect(await Bun.file(path.join(root, "never")).exists()).toBe(false)
  } finally {
    await occupied.release()
  }
})
