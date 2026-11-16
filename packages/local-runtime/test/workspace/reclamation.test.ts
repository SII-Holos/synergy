import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { RetainedWorkspaceBlobs } from "../../src/workspace/retained-blobs"
import { createHash } from "node:crypto"

test("interrupted last-owner cleanup cannot remove a later upload of the same bytes", async () => {
  await using tmp = await tmpdir()
  const cache = new RetainedWorkspaceBlobs(tmp.path)
  const bytes = new TextEncoder().encode("shared after interrupted release")
  const hash = WorkspaceTree.hash(bytes)
  const old = { kind: "checkpoint" as const, id: "old" }
  await cache.put(hash, bytes, old)
  const directory = path.join(tmp.path, "owners", `checkpoint-${createHash("sha256").update(old.id).digest("hex")}`)
  await Bun.write(path.join(directory, "released"), "")
  await fs.unlink(path.join(tmp.path, "objects", hash))
  const fresh = { kind: "mount" as const, id: "fresh" }
  await cache.put(hash, bytes, fresh)
  await cache.release(old)
  expect(await cache.get(hash, bytes.length)).toEqual(bytes)
  await cache.release(fresh)
  expect(await cache.get(hash, bytes.length)).toBeUndefined()
  await cache.put(hash, bytes, old)
  expect(await cache.get(hash, bytes.length)).toBeUndefined()
})

test("concurrent owners retain one physical blob until every acknowledgement completes", async () => {
  await using tmp = await tmpdir()
  const cache = new RetainedWorkspaceBlobs(tmp.path)
  const bytes = new Uint8Array(1024 * 1024).fill(41)
  const hash = WorkspaceTree.hash(bytes)
  const owners = Array.from({ length: 8 }, (_, i) => ({ kind: "execution" as const, id: `owner-${i}` }))
  await Promise.all(owners.map((owner) => cache.put(hash, bytes, owner)))
  expect((await fs.stat(path.join(tmp.path, "objects", hash))).nlink).toBe(owners.length + 1)
  await Promise.all(owners.slice(1).map((owner) => cache.release(owner)))
  expect(await cache.get(hash, bytes.length)).toEqual(bytes)
  await cache.release(owners[0]!)
  expect(await fs.readdir(path.join(tmp.path, "objects"))).toEqual([])
})

test("acknowledgements reclaim snapshots without deleting another checkpoint or upload's shared bytes", async () => {
  await using tmp = await tmpdir()
  const options = {
    directory: path.join(tmp.path, "receipts"),
    materializationRoot: path.join(tmp.path, "views"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
  }
  let host = new NativeWorkspaceFiles(options)
  try {
    const empty = WorkspaceTree.encode({ version: 1, entries: [] })
    const manifest = WorkspaceTree.hash(empty)
    const mounts = []
    for (const id of ["one", "two"]) {
      await host.putBlob(manifest, empty, { kind: "mount", id })
      mounts.push(
        await host.mount({
          id,
          workspaceID: id,
          generation: 1,
          readOnly: false,
          source: { kind: "materialized", manifest },
        }),
      )
    }
    const bytes = Buffer.alloc(1024 * 1024, 120)
    const hash = WorkspaceTree.hash(bytes)
    const first = await host.write({
      id: "first",
      mount: mounts[0]!,
      path: "file",
      data: bytes.toString("base64"),
      expectedVersion: null,
    })
    const second = await host.write({
      id: "second",
      mount: mounts[1]!,
      path: "file",
      data: bytes.toString("base64"),
      expectedVersion: null,
    })
    const tree = await host.getBlob(second.manifest!, WorkspaceTree.manifestBytes)
    await host.acknowledge(first.id)
    expect(await host.getBlob(hash, bytes.length)).toEqual(bytes)
    await host.close()
    host = new NativeWorkspaceFiles(options)
    expect((await host.checkpointStatus(first.id))?.state).toBe("released")
    expect((await host.checkpointStatus(second.id))?.state).toBe("saved")
    await host.putBlob(hash, bytes, { kind: "mount", id: "third" })
    await host.putBlob(second.manifest!, tree, { kind: "mount", id: "third" })
    await host.acknowledge(second.id)
    await host.acknowledge(first.id)
    expect(await host.getBlob(hash, bytes.length)).toEqual(bytes)
    const third = await host.mount({
      id: "third",
      workspaceID: "third",
      generation: 1,
      readOnly: false,
      source: { kind: "materialized", manifest: second.manifest! },
    })
    expect(await Bun.file(path.join(third.path, "file")).bytes()).toEqual(bytes)
    await expect(host.getBlob(hash, bytes.length)).rejects.toThrow()
    expect(
      await host.write({
        id: "first",
        mount: mounts[0]!,
        path: "file",
        data: bytes.toString("base64"),
        expectedVersion: null,
      }),
    ).toEqual(first)
    for (let i = 0; i < 4; i++) {
      const checkpoint = await host.checkpoint({ id: `repeat-${i}`, mount: third })
      expect(await host.getBlob(hash, bytes.length)).toEqual(bytes)
      await host.acknowledge(checkpoint.id)
      await expect(host.getBlob(hash, bytes.length)).rejects.toThrow()
    }
    for (const mount of [...mounts, third]) await host.detach(mount)
    expect(await fs.readdir(options.materializationRoot)).toEqual([])
  } finally {
    await host.close()
  }
}, 30_000)
