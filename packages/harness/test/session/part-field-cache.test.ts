import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { SessionPartFieldCache as Cache } from "../../src/session/part-field-cache"

const key = ["sessions", "home", "ses_cache", "messages", "msg_cache", "parts", "prt_cache"]
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const bytes = Buffer.from("bounded original bytes🌏\n".repeat(100000))
const source = {
  bytes: bytes.length,
  sha256: sha(bytes),
  async *stream() {
    for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.subarray(offset, offset + 65536)
  },
}

test("published field pages survive restart and seek two exact pages without replaying their source", async () => {
  await using home = await tmpdir()
  {
    await using runtime = await testRuntime({ home: home.path })
    await runtime.run(async () => {
      const prepared = await Cache.prepare({
        key,
        field: "text",
        nativeVersion: "fixture:1",
        source,
        async validate() {},
      })
      expect(prepared.bytes).toBe(bytes.length)
      expect(prepared.sha256).toBe(sha(bytes))
    })
  }
  await using runtime = await testRuntime({ home: home.path })
  await runtime.run(async () => {
    expect((await Cache.inspect(key, "text", "fixture:1"))?.sha256).toBe(sha(bytes))
    const original = Storage.readBinary
    let reads = 0
    using count = spyOn(Storage, "readBinary").mockImplementation(async (...args) => {
      reads++
      return original(...args)
    })
    const offset = 19 * Cache.PAGE_BYTES + 17
    const range = await Cache.read({ key, field: "text", nativeVersion: "fixture:1", offset, length: Cache.PAGE_BYTES })
    expect(range.data).toEqual(bytes.subarray(offset, offset + Cache.PAGE_BYTES))
    expect(reads).toBe(2)
    const reused = await Cache.prepare({
      key,
      field: "text",
      nativeVersion: "fixture:1",
      source: {
        stream() {
          throw new Error("A published native revision must not be rescanned")
        },
      },
      async validate() {},
    })
    expect(reused.generation).toBe(range.generation)
  })
}, 15000)

test("interrupted or stale generations never publish and leave the prior complete revision readable", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Cache.prepare({ key, field: "text", nativeVersion: "fixture:1", source, async validate() {} })
    const controller = new AbortController()
    await expect(
      Cache.prepare({
        key,
        field: "text",
        nativeVersion: "fixture:2",
        signal: controller.signal,
        source: {
          async *stream() {
            yield bytes.subarray(0, 2 * Cache.PAGE_BYTES)
            controller.abort(new Error("cancel native preparation"))
            controller.signal.throwIfAborted()
          },
        },
        async validate() {},
      }),
    ).rejects.toThrow("cancel native preparation")
    expect(await Cache.inspect(key, "text", "fixture:2")).toBeUndefined()
    await expect(
      Cache.prepare({
        key,
        field: "text",
        nativeVersion: "fixture:3",
        source,
        async validate() {
          throw new Error("native revision changed")
        },
      }),
    ).rejects.toThrow("native revision changed")
    expect(await Cache.inspect(key, "text", "fixture:3")).toBeUndefined()
    expect((await Cache.read({ key, field: "text", nativeVersion: "fixture:1", offset: 0, length: 100 })).data).toEqual(
      bytes.subarray(0, 100),
    )
    expect((await Storage.artifactReferences({ prefix: ["part_field_cache"], limit: 100 })).length).toBe(
      Math.ceil(bytes.length / Cache.PAGE_BYTES),
    )
  })
}, 15000)

test("collection waits for active range leases and regenerable pages have no canonical authority", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Cache.prepare({ key, field: "text", nativeVersion: "fixture:1", source, async validate() {} })
    let begin!: () => void
    const entered = new Promise<void>((resolve) => {
      begin = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = Storage.readBinary
    using delay = spyOn(Storage, "readBinary").mockImplementation(async (...args) => {
      begin()
      await blocked
      return original(...args)
    })
    const read = Cache.read({ key, field: "text", nativeVersion: "fixture:1", offset: 17, length: 100 })
    await entered
    let collected = false
    const collect = Cache.collect(Date.now() + 100000).then((result) => {
      collected = true
      return result
    })
    await Promise.resolve()
    expect(collected).toBe(false)
    release()
    expect((await read).data).toEqual(bytes.subarray(17, 117))
    expect(await collect).toBe(1)
    expect(await Cache.inspect(key, "text", "fixture:1")).toBeUndefined()
    expect(await Storage.artifactReferences({ prefix: ["part_field_cache"], limit: 1 })).toEqual([])
    expect(
      (await Cache.prepare({ key, field: "text", nativeVersion: "fixture:1", source, async validate() {} })).sha256,
    ).toBe(sha(bytes))
  })
}, 15000)

test("an altered cache page fails its original checksum and is retired for a native rebuild", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Cache.prepare({ key, field: "text", nativeVersion: "fixture:1", source, async validate() {} })
    const page = (await Storage.artifactReferences({ prefix: ["part_field_cache"], limit: 1 }))[0]
    await Storage.writeBinary(page.key, new Uint8Array(page.location.size))
    await expect(
      Cache.read({ key, field: "text", nativeVersion: "fixture:1", offset: 0, length: 100 }),
    ).rejects.toThrow("checksum")
    expect(await Cache.inspect(key, "text", "fixture:1")).toBeUndefined()
    expect(
      (await Cache.prepare({ key, field: "text", nativeVersion: "fixture:1", source, async validate() {} })).sha256,
    ).toBe(sha(bytes))
    expect(
      (await Cache.read({ key, field: "text", nativeVersion: "fixture:1", offset: 17, length: 100 })).data,
    ).toEqual(bytes.subarray(17, 117))
  })
}, 15000)
