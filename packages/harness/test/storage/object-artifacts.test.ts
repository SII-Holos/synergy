import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { ObjectArtifacts } from "../../src/storage/object-artifacts"
import { StorageCommitUnknownError } from "../../src/storage/errors"
import { storageTestOptions } from "../support/storage-backends"
import { storageTestRuntime } from "../support/storage-runtime"
import { createHash } from "node:crypto"
import { ArtifactLocation } from "../../src/storage/artifact-location"

const runtime = await storageTestRuntime()
afterAll(() => runtime.close())
const day = 86_400_000

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "object-artifacts-"))
  const options = storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(root, "db") })
  let store = await TransactionalStore.open(options)
  const objects = new Map<string, Uint8Array>()
  const writes: string[] = []
  let now = Date.now()
  let failUpload = false
  const blobs = {
    async put(hash: string, bytes: Uint8Array) {
      expect((await store.list(["storage_object_intents"])).length).toBeGreaterThan(0)
      if (failUpload) throw new Error("object service unavailable")
      writes.push(hash)
      objects.set(hash, new Uint8Array(bytes))
    },
    async get(hash: string, maximum: number) {
      const bytes = objects.get(hash)
      if (!bytes) throw new Error("object missing")
      if (bytes.length > maximum) throw new Error("object over limit")
      return bytes
    },
    async delete(hash: string) {
      objects.delete(hash)
    },
  }
  const handle = () => ({
    store,
    artifactDirectory: path.join(root, crypto.randomUUID()),
    artifactObjects: { blobs, writerID: "writer-one", now: () => now },
  })
  return {
    root,
    objects,
    writes,
    blobs,
    handle,
    store: () => store,
    advance: (ms: number) => {
      now += ms
    },
    failUpload: () => {
      failUpload = true
    },
    async reopen() {
      await store.close()
      store = await TransactionalStore.open(options)
    },
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("object artifacts recover from the database and blobs with no original local directory", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const bytes = new Uint8Array(ObjectArtifacts.chunkBytes + 13).fill(41)
    const first = f.handle()
    await Storage.provide(first, () => Storage.writeBinary(["evidence", "large"], bytes))
    expect(await fs.exists(first.artifactDirectory)).toBe(false)
    expect(await f.store().list(["storage_object_intents"])).toEqual([])
    await f.reopen()
    const second = f.handle()
    await Storage.provide(second, async () => {
      expect(await Storage.readBinary(["evidence", "large"])).toEqual(bytes)
      expect(await Storage.validateArtifacts(second)).toBe(1)
      await expect(Storage.readBinary(["evidence", "large"], { maxBytes: 1 })).rejects.toThrow("byte limit")
    })
    expect(await fs.exists(second.artifactDirectory)).toBe(false)
  }))

test("object artifact streams use paged manifests without whole-artifact buffering", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const handle = f.handle()
    const block = new Uint8Array(ObjectArtifacts.chunkBytes).fill(0x33)
    const expected = createHash("sha256")
    await Storage.provide(handle, async () => {
      using prepared = await Storage.prepareBinaryStream(
        ["evidence", "streamed"],
        (async function* () {
          for (let index = 0; index < 129; index++) {
            expected.update(block)
            yield block
          }
        })(),
      )
      await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
      const actual = createHash("sha256")
      let bytes = 0
      for await (const chunk of Storage.readBinaryStream(["evidence", "streamed"])) {
        expect(chunk.length).toBeLessThanOrEqual(ObjectArtifacts.chunkBytes)
        actual.update(chunk)
        bytes += chunk.length
      }
      expect(bytes).toBe(129 * block.length)
      expect(actual.digest("hex")).toBe(expected.digest("hex"))
      const location = await f.store().snapshot((tx) => tx.artifact(["evidence", "streamed"]))
      const manifest = JSON.parse(Buffer.from(f.objects.get(location.pack.slice(0, -5))!).toString()) as {
        version: number
        pageCount: number
      }
      expect(manifest).toMatchObject({ version: 2, pageCount: 2 })
      expect(await fs.exists(handle.artifactDirectory)).toBe(false)
      expect(await f.store().list(["storage_object_streams"])).toEqual([])
    })
  }))

test("interrupted streams retain every uploaded object until an explicit writer retirement or abort grace period", () =>
  runtime.run(async () => {
    await using f = await fixture()
    await Storage.provide(f.handle(), async () => {
      await expect(
        Storage.prepareBinaryStream(
          ["evidence", "failed-stream"],
          (async function* () {
            yield new Uint8Array(ObjectArtifacts.chunkBytes).fill(0x71)
            throw new Error("Interrupted stream")
          })(),
        ),
      ).rejects.toThrow("Interrupted stream")
      expect(f.objects.size).toBe(1)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      f.advance(8 * day)
      await Storage.collectArtifactGarbage({ scanOrphans: true })
      expect(f.objects.size).toBe(0)
    })
  }))

test("version-one manifests remain stream-readable and verified alongside version-two pages", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const bytes = Buffer.from("Historical object artifact")
    const digest = createHash("sha256").update(bytes).digest("hex")
    const manifest = { version: 1, size: bytes.length, sha256: digest, chunks: [{ hash: digest, size: bytes.length }] }
    const encoded = Buffer.from(JSON.stringify(manifest))
    const id = createHash("sha256").update(encoded).digest("hex")
    f.objects.set(digest, bytes)
    f.objects.set(id, encoded)
    const location = ArtifactLocation.parse({
      pack: `${id}.pack`,
      blockOffset: 0,
      blockBytes: bytes.length,
      decodedBytes: bytes.length,
      offset: 0,
      size: bytes.length,
      codec: "raw",
      sha256: digest,
    })
    await f.store().transaction(async (tx) => {
      await tx.write(["storage_object_manifests", id], { manifest })
      await tx.writeArtifacts([{ key: ["evidence", "historical"], location }])
    })
    await Storage.provide(f.handle(), async () => {
      const parts: Uint8Array[] = []
      for await (const chunk of Storage.readBinaryStream(["evidence", "historical"])) parts.push(chunk)
      expect(Buffer.concat(parts)).toEqual(bytes)
      expect(await Storage.validateArtifacts(f.handle())).toBe(1)
    })
  }))

test("stream cancellation and corrupted manifest pages cannot publish or yield unchecked content", () =>
  runtime.run(async () => {
    await using f = await fixture()
    await Storage.provide(f.handle(), async () => {
      const controller = new AbortController()
      await expect(
        Storage.prepareBinaryStream(
          ["evidence", "cancelled"],
          (async function* () {
            yield new Uint8Array(ObjectArtifacts.chunkBytes).fill(9)
            controller.abort(new Error("Cancelled object stream"))
            yield new Uint8Array([1])
          })(),
          { signal: controller.signal },
        ),
      ).rejects.toThrow("Cancelled object stream")
      await expect(Storage.readBinary(["evidence", "cancelled"])).rejects.toMatchObject({ name: "NotFoundError" })
      await Storage.writeBinary(["evidence", "valid"], new Uint8Array([1, 2, 3]))
      const location = await f.store().snapshot((tx) => tx.artifact(["evidence", "valid"]))
      const id = location.pack.slice(0, -5)
      const pages = await f
        .store()
        .snapshot((tx) => tx.query<{ hash: string; page: unknown }>({ prefix: ["storage_object_pages", id], limit: 1 }))
      f.objects.set(pages[0]!.value.hash, new Uint8Array([0]))
      const reader = Storage.readBinaryStream(["evidence", "valid"])
      await expect(reader.next()).rejects.toThrow("checksum")
    })
  }))

test("a lost streamed preparation acknowledgement keeps its sealed objects pinned", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const original = f.store().transaction.bind(f.store())
    using failure = spyOn(f.store(), "transaction").mockImplementation(async (body, options) => {
      const result = await original(body, options)
      if (options?.operationID?.startsWith("artifact-stream-prepare:"))
        throw new StorageCommitUnknownError(options.operationID, new Error("Lost stream preparation acknowledgement"))
      return result
    })
    await Storage.provide(f.handle(), async () => {
      await expect(
        Storage.prepareBinaryStream(
          ["evidence", "uncertain-stream"],
          (async function* () {
            yield new Uint8Array([1, 7, 3])
          })(),
        ),
      ).rejects.toBeInstanceOf(StorageCommitUnknownError)
      expect((await f.store().list(["storage_object_intents"])).length).toBe(1)
      f.advance(30 * day)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      expect(f.objects.size).toBeGreaterThan(0)
    })
  }))

test("a stopped writer's unfinished stream requires explicit retirement before orphan collection", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const initial = new ObjectArtifacts(f.store(), f.handle().artifactObjects)
    await expect(
      initial.prepareStream(
        (async function* () {
          yield new Uint8Array(ObjectArtifacts.chunkBytes).fill(0x56)
          throw new Error("Process stopped after its first chunk")
        })(),
      ),
    ).rejects.toThrow("Process stopped")
    const next = new ObjectArtifacts(f.store(), { ...f.handle().artifactObjects, writerID: "writer-two" })
    f.advance(30 * day)
    expect(await next.collect([])).toBe(0)
    expect(f.objects.size).toBe(1)
    await next.retireWriter("writer-one")
    expect(await next.collect([])).toBe(0)
    f.advance(8 * day)
    expect(await next.collect([])).toBe(1)
    expect(f.objects.size).toBe(0)
  }))

test("paged object manifests exceed the historical single-array chunk ceiling", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const bytes = new Uint8Array([5])
    const digest = createHash("sha256").update(bytes).digest("hex")
    f.objects.set(digest, bytes)
    let previous: string | undefined
    const pages: Array<{
      hash: string
      page: { version: number; index: number; previous?: string; chunks: Array<{ hash: string; size: number }> }
    }> = []
    const chunkCount = 32_769
    for (let start = 0; start < chunkCount; start += 128) {
      const page = {
        version: 2,
        index: pages.length,
        previous,
        chunks: Array.from({ length: Math.min(128, chunkCount - start) }, () => ({ hash: digest, size: 1 })),
      }
      const encoded = Buffer.from(JSON.stringify(page))
      previous = createHash("sha256").update(encoded).digest("hex")
      f.objects.set(previous, encoded)
      pages.push({ hash: previous, page })
    }
    const sha256 = createHash("sha256").update(new Uint8Array(chunkCount).fill(5)).digest("hex")
    const manifest = { version: 2, size: chunkCount, sha256, pageCount: pages.length, chunkCount, tail: previous }
    const encoded = Buffer.from(JSON.stringify(manifest))
    const id = createHash("sha256").update(encoded).digest("hex")
    f.objects.set(id, encoded)
    const location = ArtifactLocation.parse({
      pack: `${id}.pack`,
      blockOffset: 0,
      blockBytes: chunkCount,
      decodedBytes: chunkCount,
      offset: 0,
      size: chunkCount,
      codec: "raw",
      sha256,
    })
    await f.store().transaction(async (tx) => {
      for (let index = 0; index < pages.length; index++)
        await tx.write(["storage_object_pages", id, String(index).padStart(16, "0")], pages[index])
      await tx.write(["storage_object_manifests", id], { manifest })
      await tx.writeArtifacts([{ key: ["evidence", "many-chunks"], location }])
    })
    await Storage.provide(f.handle(), async () => {
      let count = 0
      for await (const chunk of Storage.readBinaryStream(["evidence", "many-chunks"])) count += chunk.length
      expect(count).toBe(chunkCount)
    })
  }))

test("missing or corrupt objects fail closed and failed uploads cannot publish a reference", () =>
  runtime.run(async () => {
    await using f = await fixture()
    await Storage.provide(f.handle(), async () => {
      await Storage.writeBinary(["evidence", "original"], new Uint8Array([1, 2, 3]))
      const chunk = f.writes[0]!
      f.objects.set(chunk, new Uint8Array([1, 2, 4]))
      await expect(Storage.readBinary(["evidence", "original"])).rejects.toThrow("checksum")
      f.objects.delete(chunk)
      await expect(Storage.readBinary(["evidence", "original"])).rejects.toThrow("missing")
      f.failUpload()
      await expect(Storage.writeBinary(["evidence", "failed"], new Uint8Array([5]))).rejects.toThrow("unavailable")
      await expect(Storage.readBinary(["evidence", "failed"])).rejects.toMatchObject({ name: "NotFoundError" })
    })
  }))

test("collection retains shared chunks, prepared writes and backup pins for the full grace period", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const shared = new Uint8Array(ObjectArtifacts.chunkBytes).fill(3)
    const larger = new Uint8Array(shared.length + 1)
    larger.set(shared)
    larger[shared.length] = 4
    await Storage.provide(f.handle(), async () => {
      await Storage.writeBinary(["evidence", "a"], shared)
      await Storage.writeBinary(["evidence", "b"], larger)
      const location = await f.store().snapshot((tx) => tx.artifact(["evidence", "a"]))
      await Storage.write(["storage_pack_pins", location.pack, "backup"], { reason: "backup" })
      await Storage.removeTree(["evidence", "a"])
      using prepared = await Storage.prepareBinary(["evidence", "pending"], new Uint8Array([99]))
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      f.advance(8 * day)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      await Storage.removeTree(["storage_pack_pins"])
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      f.advance(8 * day)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
      expect(await Storage.readBinary(["evidence", "b"])).toEqual(larger)
      await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
      expect(await Storage.readBinary(["evidence", "pending"])).toEqual(new Uint8Array([99]))
    })
  }))

test("a crashed preparation remains pinned until its specific stopped writer is retired", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const bytes = new Uint8Array([7, 8, 9])
    await Storage.provide(f.handle(), () => Storage.prepareBinary(["evidence", "uncommitted"], bytes))
    await f.reopen()
    const next = {
      ...f.handle(),
      artifactObjects: { blobs: f.blobs, writerID: "writer-two", now: () => Date.now() + 30 * day },
    }
    await Storage.provide(next, async () => {
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      expect(f.objects.size).toBeGreaterThan(0)
      await Storage.retireArtifactWriter("writer-one")
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      await expect(Storage.retireArtifactWriter("writer-two")).rejects.toThrow("current")
    })
    const later = { ...next, artifactObjects: { ...next.artifactObjects, now: () => Date.now() + 38 * day } }
    await f.reopen()
    later.store = f.store()
    await Storage.provide(later, async () => {
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
      expect(f.objects.size).toBe(0)
    })
  }))

test("an uncertain publication retains its durable intent instead of being mistaken for an aborted write", () =>
  runtime.run(async () => {
    await using f = await fixture()
    await Storage.provide(f.handle(), async () => {
      using prepared = await Storage.prepareBinary(["evidence", "unknown"], new Uint8Array([45]))
      const original = f.store().transaction.bind(f.store())
      const rollback = new Error("simulated lost commit acknowledgement")
      using failure = spyOn(f.store(), "transaction").mockImplementationOnce(async (body) => {
        await original(async (tx) => {
          await body(tx)
          throw rollback
        }).catch((error) => {
          if (error !== rollback) throw error
        })
        throw new StorageCommitUnknownError("unknown-write", rollback)
      })
      await expect(Storage.transaction(() => Storage.publishPreparedBinary(prepared))).rejects.toBeInstanceOf(
        StorageCommitUnknownError,
      )
      expect((await f.store().list(["storage_object_intents"])).length).toBe(1)
      f.advance(30 * day)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      expect(f.objects.size).toBeGreaterThan(0)
    })
  }))

test("an interrupted object deletion resumes and rejects publication into a deleting manifest", () =>
  runtime.run(async () => {
    await using f = await fixture()
    await Storage.provide(f.handle(), async () => {
      await Storage.writeBinary(["evidence", "removed"], new Uint8Array([101]))
      await Storage.removeTree(["evidence"])
      await Storage.collectArtifactGarbage({ scanOrphans: true })
      f.advance(8 * day)
      using failure = spyOn(f.blobs, "delete").mockRejectedValueOnce(new Error("delete unavailable"))
      await expect(Storage.collectArtifactGarbage({ scanOrphans: true })).rejects.toThrow("unavailable")
      await expect(Storage.prepareBinary(["evidence", "again"], new Uint8Array([101]))).rejects.toThrow(
        "being reclaimed",
      )
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
      expect(f.objects.size).toBe(0)
      await Storage.writeBinary(["evidence", "again"], new Uint8Array([101]))
      expect(await Storage.readBinary(["evidence", "again"])).toEqual(new Uint8Array([101]))
    })
  }))

test("validation pins its database snapshot while concurrent deletion and collection advance", () =>
  runtime.run(async () => {
    await using f = await fixture()
    const handle = f.handle()
    await Storage.provide(handle, async () => {
      await Storage.writeBinary(["evidence", "snapshot"], new Uint8Array([77]))
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const get = f.blobs.get.bind(f.blobs)
      using wait = spyOn(f.blobs, "get").mockImplementationOnce(async (hash, maximum) => {
        started.resolve()
        await resume.promise
        return get(hash, maximum)
      })
      const validating = Storage.validateArtifacts(handle)
      await started.promise
      try {
        await Storage.removeTree(["evidence"])
        await Storage.collectArtifactGarbage({ scanOrphans: true })
        f.advance(30 * day)
        expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      } finally {
        resume.resolve()
      }
      expect(await validating).toBe(1)
      expect(await f.store().list(["storage_object_intents"])).toEqual([])
    })
  }))
