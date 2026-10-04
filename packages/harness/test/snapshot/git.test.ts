import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function captured(bytes: Uint8Array) {
  return { bytes, hash: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") }
}

test("streamed blob imports preserve framing, publish one pack and create no references", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "stream.git")
    await SnapshotStore.initializeBareRepository(repo)
    const blobs = Array.from({ length: 700 }, (_, index) =>
      captured(Buffer.concat([Buffer.from(`blob\ndata 99\ndone\nget-mark :${index}\n\0`, "binary"), randomBytes(512)])),
    )
    await using writer = await SnapshotGit.blobWriter(repo, AbortSignal.timeout(5000))
    await writer.write(blobs.slice(0, 350))
    await writer.write(blobs.slice(350))
    await writer.finish()
    expect(
      (await fs.readdir(path.join(repo, "objects", "pack"))).filter((name) => name.endsWith(".pack")),
    ).toHaveLength(1)
    expect(await SnapshotGit.checked(repo, ["for-each-ref"])).toBe("")
    const result = await SnapshotGit.run(["git", "--git-dir", repo, "cat-file", "blob", blobs[699]!.hash], tmp.path)
    expect(result.bytes).toEqual(blobs[699]!.bytes)
  }))

test("streamed imports reject an object acknowledgement that differs from captured bytes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "rejected.git")
    await SnapshotStore.initializeBareRepository(repo)
    await using writer = await SnapshotGit.blobWriter(repo, AbortSignal.timeout(5000))
    await expect(writer.write([{ bytes: Buffer.from("actual bytes"), hash: "a".repeat(40) }])).rejects.toThrow(
      "acknowledgement",
    )
    await expect(writer.finish()).rejects.toThrow()
    expect(await SnapshotGit.checked(repo, ["for-each-ref"])).toBe("")
  }))

test("streamed imports retain timeout propagation between writes and drain cancellation", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "cancelled.git")
    await SnapshotStore.initializeBareRepository(repo)
    const signal = AbortSignal.timeout(1000)
    const writer = await SnapshotGit.blobWriter(repo, signal)
    try {
      await writer.write([captured(Buffer.from("pending content"))])
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      await expect(writer.finish()).rejects.toThrow()
    } finally {
      await writer[Symbol.asyncDispose]()
    }
    expect(await SnapshotGit.checked(repo, ["for-each-ref"])).toBe("")
    expect(
      (await fs.readdir(path.join(repo, "objects", "pack"))).filter((name) => name.endsWith(".pack")),
    ).toHaveLength(0)
  }))

async function fixture() {
  const tmp = await tmpdir({ git: true })
  const source = path.join(tmp.path, "source.git")
  const target = path.join(tmp.path, "target.git")
  await SnapshotStore.initializeBareRepository(source)
  await SnapshotStore.initializeBareRepository(target)
  const content = randomBytes(16 * 1024 * 1024)
  const blob = path.join(tmp.path, "large.bin")
  await Bun.write(blob, content)
  const oid = await SnapshotGit.checked(source, ["hash-object", "-w", blob])
  const inventory = path.join(tmp.path, "inventory")
  await Bun.write(inventory, oid + "\n")
  return { tmp, source, target, content, oid, inventory }
}

test("snapshot transfer reports a rejected destination and preserves its source for retry", () =>
  runtime.run(async () => {
    const { tmp, source, target, oid, inventory } = await fixture()
    await using cleanup = tmp
    await SnapshotGit.checked(target, ["config", "core.repositoryformatversion", "999"])
    await expect(SnapshotGit.importObjects(source, target, inventory)).rejects.toThrow("index-pack")
    await fs.rm(target, { recursive: true })
    await SnapshotStore.initializeBareRepository(target)
    const keep = await SnapshotGit.importObjects(source, target, inventory)
    expect(await Bun.file(path.join(target, "objects", "pack", `pack-${keep}.keep`)).exists()).toBe(true)
    expect(await SnapshotGit.checked(target, ["cat-file", "-s", oid])).toBe(String(16 * 1024 * 1024))
    await SnapshotGit.checked(target, ["fsck", "--full"])
  }))

test("snapshot transfer preserves large object bytes and cleans its staging files", () =>
  runtime.run(async () => {
    const { tmp, source, target, content, oid, inventory } = await fixture()
    await using cleanup = tmp
    const before = (await fs.readdir(tmp.path)).sort()
    await SnapshotGit.importObjects(source, target, inventory)
    const result = Bun.spawn(["git", "--git-dir", target, "cat-file", "blob", oid], {
      env: SnapshotGit.environment(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [bytes, code] = await Promise.all([new Response(result.stdout).arrayBuffer(), result.exited])
    expect(code).toBe(0)
    expect(Buffer.from(bytes).equals(content)).toBe(true)
    expect((await fs.readdir(tmp.path)).sort()).toEqual(before)
  }))

afterRuntimeTests(() => runtime.close())
