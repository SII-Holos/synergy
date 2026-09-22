import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StoragePortable } from "../../src/storage/portable"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-pack-"))
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    process.env.SYNERGY_TEST_POSTGRES_URL
      ? { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL }
      : { backend: "sqlite", namespace, filename: path.join(root, "data.sqlite") },
  )
  return {
    root,
    store,
    artifactDirectory: path.join(root, "data"),
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test(
  "small binary writes share durable packs, enforce bounds and survive reopen and portable transfer",
  () =>
    runtime.run(async () => {
      await using source = await fixture()
      const values = Array.from({ length: 300 }, (_, n) =>
        n % 2 ? randomBytes(73) : Buffer.from("evidence".repeat(300)),
      )
      await Storage.provide(source, async () => {
        for (const [n, bytes] of values.entries()) await Storage.writeBinary(["blobs", String(n)], bytes)
        for (const [n, bytes] of values.entries())
          expect(await Storage.readBinary(["blobs", String(n)])).toEqual(new Uint8Array(bytes))
        await expect(Storage.readBinary(["blobs", "0"], { maxBytes: 3 })).rejects.toThrow("byte limit")
      })
      const packs = await fs.readdir(path.join(source.artifactDirectory, "agent-artifacts"))
      expect(packs.length).toBeLessThan(5)
      const archive = path.join(source.root, "records.ndjson")
      await StoragePortable.exportFile(source.store, archive)
      await using target = await fixture()
      await fs.cp(
        path.join(source.artifactDirectory, "agent-artifacts"),
        path.join(target.artifactDirectory, "agent-artifacts"),
        { recursive: true },
      )
      await StoragePortable.importFile(target.store, archive)
      await Storage.provide(target, async () => {
        for (const [n, bytes] of values.entries())
          expect(await Storage.readBinary(["blobs", String(n)])).toEqual(new Uint8Array(bytes))
      })
    }),
  20000,
)

test("deleting an owner removes binary references and delayed writes cannot resurrect them", () =>
  runtime.run(async () => {
    await using handle = await fixture()
    const owner = ["sessions", "scope", "session"]
    await handle.store.write([...owner, "info"], { id: "session" })
    await Storage.provide(handle, async () => {
      await Storage.writeBinary([...owner, "rollout", "blobs", "a"], Buffer.from("original"))
      await Storage.removeTree(owner)
      await expect(Storage.readBinary([...owner, "rollout", "blobs", "a"])).rejects.toMatchObject({
        name: "NotFoundError",
      })
      await expect(Storage.writeBinary([...owner, "rollout", "blobs", "b"], Buffer.from("late"))).rejects.toThrow(
        "deleted",
      )
    })
  }))

test("permanent deletion reclaims unreferenced packs and repeated content does not append duplicates", () =>
  runtime.run(async () => {
    await using handle = await fixture()
    const owner = ["sessions", "scope", "garbage"]
    const key = [...owner, "rollout", "blobs", "content"]
    await handle.store.write([...owner, "info"], { id: "garbage" })
    await Storage.provide(handle, async () => {
      await Storage.writeBinary(key, Buffer.from("kept content"))
      const location = await handle.store.snapshot((tx) => tx.artifact(key))
      const filename = path.join(handle.artifactDirectory, "agent-artifacts", location.pack)
      const before = (await fs.stat(filename)).size
      for (let n = 0; n < 10; n++) await Storage.writeBinary(key, Buffer.from("kept content"))
      expect((await fs.stat(filename)).size).toBe(before)
      await Storage.removeTree(owner)
      await Storage.collectArtifactGarbage()
      expect(await fs.readdir(path.dirname(filename))).toEqual([])
      await Storage.writeBinary(["blobs", "after-gc"], Buffer.from("new content"))
      expect(Buffer.from(await Storage.readBinary(["blobs", "after-gc"])).toString()).toBe("new content")
    })
  }))

test("offline recovery reclaims bytes flushed before an uncommitted reference", () =>
  runtime.run(async () => {
    await using handle = await fixture()
    const { ArtifactPack } = await import("../../src/storage/artifact-pack")
    const pack = new ArtifactPack(path.join(handle.artifactDirectory, "agent-artifacts"))
    const unpublished = await pack.append(Buffer.from("flushed but never published"))
    const filename = path.join(handle.artifactDirectory, "agent-artifacts", unpublished.pack)
    expect(await Bun.file(filename).exists()).toBe(true)
    await Storage.provide(handle, async () => {
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
      expect(await Bun.file(filename).exists()).toBe(false)
    })
  }))

test("a verifier pins immutable packs while a concurrent deletion commits", () =>
  runtime.run(async () => {
    await using handle = await fixture()
    const { ArtifactPack } = await import("../../src/storage/artifact-pack")
    const owner = ["sessions", "scope", "reader"]
    await handle.store.write([...owner, "info"], { id: "reader" })
    await Storage.provide(handle, async () => {
      await Storage.writeBinary([...owner, "rollout", "blobs", "value"], Buffer.from("stable snapshot"))
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const original = ArtifactPack.prototype.read
      using read = spyOn(ArtifactPack.prototype, "read").mockImplementation(async function (
        this: InstanceType<typeof ArtifactPack>,
        location,
        maxBytes,
      ) {
        started.resolve()
        await release.promise
        return original.call(this, location, maxBytes)
      })
      const verifying = Storage.validateArtifacts(handle)
      verifying.catch(() => {})
      await started.promise
      try {
        await Storage.removeTree(owner)
        expect(await Storage.collectArtifactGarbage()).toBe(0)
      } finally {
        release.resolve()
      }
      expect(await verifying).toBe(1)
      expect(await Storage.collectArtifactGarbage()).toBe(1)
    })
  }))

afterRuntimeTests(() => runtime.close())
test("durable import pins preserve orphan packs and queued garbage across collection", () =>
  runtime.run(async () => {
    await using handle = await fixture()
    await Storage.provide(handle, async () => {
      const key = ["blobs", "imported"]
      await Storage.writeBinary(key, Buffer.from("durable recovery bytes"))
      const location = await handle.store.snapshot((tx) => tx.artifact(key))
      const pin = ["storage_pack_pins", location.pack, "pending-owner"]
      await Storage.write(pin, { backupID: "recovery" })
      await Storage.removeTree(["blobs"])
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      expect(await Bun.file(path.join(handle.artifactDirectory, "agent-artifacts", location.pack)).exists()).toBe(true)
      await Storage.remove(pin)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
    })
  }))
