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

test("file view metadata and bounded ranges refer to the same content version", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  await fs.mkdir(root)
  await Bun.write(path.join(root, "file"), "abcdef")
  await fs.symlink("file", path.join(root, "link"))
  const host = new NativeWorkspaceFiles({
    directory: path.join(tmp.path, "receipts"),
    materializationRoot: path.join(tmp.path, "views"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
  })
  const mount = { id: "mount", workspaceID: "workspace", generation: 1 }
  await host.mount({ ...mount, readOnly: false, source: { kind: "directory", path: root } })
  expect((await host.stat(mount, ""))?.kind).toBe("directory")
  expect((await host.stat(mount, "link"))?.kind).toBe("symlink")
  expect(await host.stat(mount, "absent")).toBeUndefined()
  const first = await host.read({ mount, path: "file", offset: 1, maximumBytes: 2 })
  expect(Buffer.from(first.data, "base64").toString()).toBe("bc")
  expect(first.size).toBe(6)
  const next = await host.read({ mount, path: "file", offset: 3, maximumBytes: 3, expectedVersion: first.version })
  expect(Buffer.from(next.data, "base64").toString()).toBe("def")
  await Bun.write(path.join(root, "file"), "changed")
  await expect(
    host.read({ mount, path: "file", offset: 0, maximumBytes: 2, expectedVersion: first.version }),
  ).rejects.toThrow("changed")
  await fs.symlink(tmp.path, path.join(root, "escape"))
  await expect(host.stat(mount, "escape/file")).rejects.toThrow("escapes")
})
