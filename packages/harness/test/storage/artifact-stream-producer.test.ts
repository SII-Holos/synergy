import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { withStorageQueueOptions } from "../../src/storage/queue"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { RuntimeContext } from "../../src/lifecycle/context"
import { TransactionalStore } from "../../src/storage/transactional-store"

test("a streamed binary producer can read retained bytes from its own Store without holding the destination artifact gate", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const source = ["stream-composition", "source"]
    const target = ["stream-composition", "target"]
    const bytes = Uint8Array.from({ length: 300_007 }, (_, index) => index % 251)
    await Storage.writeBinary(source, bytes)
    const controller = new AbortController()
    const reason = new Error("Rescue an artifact producer waiting behind its own destination")
    const entered = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<
      { kind: "prepared"; value: Storage.PreparedBinary } | { kind: "failed"; error: unknown } | { kind: "blocked" }
    >()
    const work = Storage.prepareBinaryStream(
      target,
      (async function* () {
        entered.resolve()
        yield* Storage.readBinaryStream(source, { signal: controller.signal })
      })(),
      { signal: controller.signal },
    ).then(
      (value) => settled.resolve({ kind: "prepared", value }),
      (error) => settled.resolve({ kind: "failed", error }),
    )
    await entered.promise
    const rescue = setTimeout(() => {
      settled.resolve({ kind: "blocked" })
      controller.abort(reason)
    }, 1000)
    try {
      const outcome = await settled.promise
      expect(outcome.kind).toBe("prepared")
      if (outcome.kind !== "prepared") throw new Error("The binary producer could not read its own Store")
      using prepared = outcome.value
      await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
      expect(await Storage.readBinary(target)).toEqual(bytes)
      expect(await Storage.readBinary(source)).toEqual(bytes)
    } finally {
      clearTimeout(rescue)
      controller.abort(reason)
      await work
    }
  })
})

test("an already cancelled inherited admission does not consume an artifact producer", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const controller = new AbortController()
    const reason = new Error("The enclosing native operation was cancelled")
    controller.abort(reason)
    let consumed = false
    await expect(
      withStorageQueueOptions({ signal: controller.signal }, () =>
        Storage.prepareBinaryStream(
          ["stream-composition", "cancelled-parent"],
          (async function* () {
            consumed = true
            yield new Uint8Array([1])
          })(),
        ),
      ),
    ).rejects.toBe(reason)
    expect(consumed).toBe(false)
  })
})

test("source read pins and prepared destination pins survive collection while producer bytes cross the spool", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const source = ["stream-composition", "pinned-source"]
    const target = ["stream-composition", "pinned-target"]
    const bytes = Uint8Array.from({ length: 300_007 }, (_, index) => index % 251)
    await Storage.writeBinary(source, bytes)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let paused = false
    const work = Storage.prepareBinaryStream(
      target,
      (async function* () {
        for await (const chunk of Storage.readBinaryStream(source)) {
          yield chunk
          if (!paused) {
            paused = true
            entered.resolve()
            await resume.promise
          }
        }
      })(),
    )
    void work.catch(() => {})
    await entered.promise
    try {
      await Storage.removeTree(source)
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
      resume.resolve()
      using prepared = await work
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
      await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
      expect(await Storage.readBinary(target)).toEqual(bytes)
      expect(await fs.readdir(path.join(Global.Path.cache, "artifact-stream-preparations"))).toEqual([])
    } finally {
      resume.resolve()
      const prepared = await work
      prepared[Symbol.dispose]()
    }
  })
})

test("producer cancellation and failure close the original iterator and discard its private spool", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    for (const kind of ["abort", "failure"] as const) {
      const controller = new AbortController()
      const reason = new Error("Original producer " + kind)
      let closed = false
      const work = withStorageQueueOptions({ signal: controller.signal }, () =>
        Storage.prepareBinaryStream(
          ["stream-composition", kind],
          (async function* () {
            try {
              yield new Uint8Array(65537).fill(0x71)
              if (kind === "failure") throw reason
              controller.abort(reason)
              yield new Uint8Array([1])
            } finally {
              closed = true
            }
          })(),
        ),
      )
      await expect(work).rejects.toBe(reason)
      expect(closed).toBe(true)
      await expect(Storage.readBinary(["stream-composition", kind])).rejects.toMatchObject({ name: "NotFoundError" })
      expect(await fs.readdir(path.join(Global.Path.cache, "artifact-stream-preparations"))).toEqual([])
    }
    expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(0)
  })
})

test("a changed private spool cannot become a prepared artifact under the producer's original checksum", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const work = Storage.prepareBinaryStream(
      ["stream-composition", "changed-spool"],
      (async function* () {
        yield new Uint8Array(65537).fill(0x71)
        entered.resolve()
        await resume.promise
      })(),
    )
    void work.catch(() => {})
    await entered.promise
    try {
      const parent = path.join(Global.Path.cache, "artifact-stream-preparations")
      const directories = await fs.readdir(parent)
      expect(directories).toHaveLength(1)
      await Bun.write(path.join(parent, directories[0], "content"), new Uint8Array(65537).fill(0x39))
      resume.resolve()
      await expect(work).rejects.toThrow("checksum")
      await expect(Storage.readBinary(["stream-composition", "changed-spool"])).rejects.toMatchObject({
        name: "NotFoundError",
      })
      expect(await fs.readdir(parent)).toEqual([])
      expect(await Storage.collectArtifactGarbage({ scanOrphans: true })).toBe(1)
    } finally {
      resume.resolve()
      await work.catch(() => {})
    }
  })
})

test("a producer cannot retarget the originally selected artifact key during asynchronous consumption", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const key = ["stream-composition", "original-target"]
    using prepared = await Storage.prepareBinaryStream(
      key,
      (async function* () {
        key[1] = "different-target"
        yield new Uint8Array([1, 7, 3])
      })(),
    )
    await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
    expect(await Storage.readBinary(["stream-composition", "original-target"])).toEqual(new Uint8Array([1, 7, 3]))
    await expect(Storage.readBinary(key)).rejects.toMatchObject({ name: "NotFoundError" })
  })
})

test("bounded producer admission queues before opening another private spool", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const primary = Storage.current()
    const other = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "other-producers",
      filename: path.join(runtime.host.root, "other-producers.sqlite"),
    })
    const alternate = { store: other, artifactDirectory: path.join(runtime.host.root, "other-artifacts") }
    const resume = Promise.withResolvers<void>()
    const entered = Array.from({ length: 16 }, () => Promise.withResolvers<void>())
    const holders = entered.map((ready, index) =>
      Storage.provide(index % 2 ? alternate : primary, () =>
        Storage.prepareBinaryStream(
          ["producer-capacity", String(index)],
          (async function* () {
            ready.resolve()
            yield new Uint8Array([1])
            await resume.promise
          })(),
        ),
      ),
    )
    for (const holder of holders) void holder.catch(() => {})
    await Promise.all(entered.map((ready) => ready.promise))
    const outcome = Promise.withResolvers<"queued" | "consumed">()
    const controller = new AbortController()
    const reason = new Error("Cancel the queued producer without opening its spool")
    const probe = withStorageQueueOptions(
      {
        onWait(waiting) {
          if (waiting) outcome.resolve("queued")
        },
      },
      () =>
        Storage.prepareBinaryStream(
          ["different-artifact-kind", "queued"],
          (async function* () {
            outcome.resolve("consumed")
            yield new Uint8Array([2])
            await resume.promise
          })(),
          { signal: controller.signal },
        ),
    )
    void probe.catch(() => {})
    try {
      expect(await outcome.promise).toBe("queued")
      expect(await fs.readdir(path.join(Global.Path.cache, "artifact-stream-preparations"))).toHaveLength(16)
      controller.abort(reason)
      await expect(probe).rejects.toBe(reason)
    } finally {
      controller.abort(reason)
      resume.resolve()
      const settled = await Promise.allSettled([...holders, probe])
      for (const item of settled) if (item.status === "fulfilled") item.value[Symbol.dispose]()
      await other.close()
    }
    expect(await fs.readdir(path.join(Global.Path.cache, "artifact-stream-preparations"))).toEqual([])
  })
})

test("a nested stream refuses saturated producer capacity without waiting behind its own parent", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const resume = Promise.withResolvers<void>()
    const attempt = Promise.withResolvers<void>()
    const entered = Array.from({ length: 16 }, () => Promise.withResolvers<void>())
    const outcome = Promise.withResolvers<{ kind: "failed"; error: unknown } | { kind: "queued" | "prepared" }>()
    const controller = new AbortController()
    let consumed = false
    const holders = entered.map((ready, index) =>
      Storage.prepareBinaryStream(
        ["producer-nesting", String(index)],
        (async function* () {
          ready.resolve()
          yield new Uint8Array([1])
          if (index === 0) {
            await attempt.promise
            await withStorageQueueOptions(
              {
                onWait(waiting) {
                  if (waiting) outcome.resolve({ kind: "queued" })
                },
              },
              () =>
                Storage.prepareBinaryStream(
                  ["producer-nesting", "nested"],
                  (async function* () {
                    consumed = true
                    yield new Uint8Array([2])
                  })(),
                  { signal: controller.signal },
                ),
            ).then(
              (prepared) => {
                prepared[Symbol.dispose]()
                outcome.resolve({ kind: "prepared" })
              },
              (error) => {
                outcome.resolve({ kind: "failed", error })
              },
            )
          }
          await resume.promise
        })(),
      ),
    )
    for (const holder of holders) void holder.catch(() => {})
    await Promise.all(entered.map((ready) => ready.promise))
    try {
      attempt.resolve()
      const result = await outcome.promise
      expect(result.kind).toBe("failed")
      if (result.kind === "failed") expect(result.error).toMatchObject({ name: "StorageBusyError" })
      expect(consumed).toBe(false)
    } finally {
      controller.abort(new Error("Rescue an incorrectly queued nested producer"))
      attempt.resolve()
      resume.resolve()
      for (const result of await Promise.allSettled(holders))
        if (result.status === "fulfilled") result.value[Symbol.dispose]()
    }
  })
})

test("Runtime close rejects new producers and drains active and queued spools before closing the backend", async () => {
  const runtime = await testRuntime()
  const resume = Promise.withResolvers<void>()
  const entered = Array.from({ length: 16 }, () => Promise.withResolvers<void>())
  const outcome = Promise.withResolvers<"admission-closed" | "backend-closed">()
  const store = runtime.run(() => Storage.current().store)
  let backendClosed = false
  let wroteAfterBackendClose = false
  const originalClose = store.close.bind(store)
  const originalAdmission = Storage.closeArtifactAdmission
  using backend = spyOn(store, "close").mockImplementation(async () => {
    backendClosed = true
    outcome.resolve("backend-closed")
    return originalClose()
  })
  using admission = spyOn(Storage, "closeArtifactAdmission").mockImplementation(() => {
    originalAdmission()
    outcome.resolve("admission-closed")
  })
  const invoke = runtime.run(() =>
    RuntimeContext.current().bind(() =>
      Storage.prepareBinaryStream(
        ["producer-shutdown", "new"],
        (async function* () {
          yield new Uint8Array([3])
        })(),
      ),
    ),
  )
  const holders = runtime.run(() =>
    entered.map((ready, index) =>
      Storage.prepareBinaryStream(
        ["producer-shutdown", String(index)],
        (async function* () {
          ready.resolve()
          yield new Uint8Array([1])
          await resume.promise
          wroteAfterBackendClose ||= backendClosed
          yield new Uint8Array([2])
        })(),
      ),
    ),
  )
  for (const holder of holders) void holder.catch(() => {})
  await Promise.all(entered.map((ready) => ready.promise))
  const queued = runtime.run(() =>
    Storage.prepareBinaryStream(
      ["producer-shutdown", "accepted-queued"],
      (async function* () {
        wroteAfterBackendClose ||= backendClosed
        yield new Uint8Array([4])
      })(),
    ),
  )
  void queued.catch(() => {})
  const closing = runtime.close()
  void closing.catch(() => {})
  try {
    expect(await outcome.promise).toBe("admission-closed")
    expect(backendClosed).toBe(false)
    await expect(invoke()).rejects.toMatchObject({ name: "StorageClosedError" })
    resume.resolve()
    for (const result of await Promise.allSettled([...holders, queued])) {
      expect(result.status).toBe("fulfilled")
      if (result.status === "fulfilled") result.value[Symbol.dispose]()
    }
    await closing
    expect(wroteAfterBackendClose).toBe(false)
    expect(backendClosed).toBe(true)
  } finally {
    resume.resolve()
    for (const result of await Promise.allSettled([...holders, queued]))
      if (result.status === "fulfilled") result.value[Symbol.dispose]()
    await closing
  }
})

test("a producer cannot change the captured artifact directory or object backend configuration", async () => {
  for (const mode of ["directory", "options", "writer", "blobs"] as const) {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const source = Storage.current()
      const blobStore = () => {
        const values = new Map<string, Uint8Array>()
        return {
          async put(id: string, bytes: Uint8Array) {
            values.set(id, bytes.slice())
          },
          async get(id: string, limit: number) {
            const value = values.get(id)
            if (!value || value.length > limit) throw new Error("Missing bounded test object")
            return value.slice()
          },
          async delete(id: string) {
            values.delete(id)
          },
        }
      }
      const blobs = blobStore()
      const options = { writerID: "original-writer", blobs }
      await Storage.provide({ ...source, artifactObjects: mode === "directory" ? undefined : options }, async () => {
        const current = Storage.current()
        const directory = current.artifactDirectory
        let prepared: Storage.PreparedBinary | undefined
        const work = Storage.prepareBinaryStream(
          ["producer-owner", mode],
          (async function* () {
            if (mode === "directory") current.artifactDirectory = path.join(runtime.host.root, "retargeted-artifacts")
            if (mode === "options") current.artifactObjects = { ...options }
            if (mode === "writer") options.writerID = "different-writer"
            if (mode === "blobs") options.blobs = blobStore()
            yield new Uint8Array([1, 7, 3])
          })(),
        ).then((value) => {
          prepared = value
          return value
        })
        try {
          await expect(work).rejects.toMatchObject({ name: "StorageConflictError" })
        } finally {
          prepared?.[Symbol.dispose]()
          current.artifactDirectory = directory
          current.artifactObjects = mode === "directory" ? undefined : options
          options.writerID = "original-writer"
          options.blobs = blobs
        }
        await expect(Storage.readBinary(["producer-owner", mode])).rejects.toMatchObject({ name: "NotFoundError" })
        expect(await fs.readdir(path.join(Global.Path.cache, "artifact-stream-preparations"))).toEqual([])
      })
    })
  }
})
