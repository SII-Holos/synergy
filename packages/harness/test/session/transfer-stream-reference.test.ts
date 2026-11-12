import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

test("portable metadata rewrites retain existing content references without reading or copying file bodies", async () => {
  await using temporary = await tmpdir()
  const objects = new Map<string, Uint8Array>()
  const body = new TextEncoder().encode("retained file content")
  const bodyHash = createHash("sha256").update(body).digest("hex")
  let bodyReads = 0
  let bodyWrites = 0
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      if (hash === bodyHash) bodyWrites++
      objects.set(hash, bytes.slice())
    },
    async get(hash: string, limit: number) {
      if (hash === bodyHash) bodyReads++
      const bytes = objects.get(hash)
      if (!bytes || bytes.length > limit) throw new Error("Missing or oversized object")
      return bytes.slice()
    },
  }
  const root = await Stream.write({
    store,
    owners: { files: 1 },
    entries: (async function* () {
      yield {
        id: "old-name",
        kind: "file" as const,
        metadata: { mode: 0o644 },
        content: (async function* () {
          yield body
        })(),
      }
    })(),
  })
  await using original = await Stream.open({ root, store, directory: temporary.path })
  const index = await original.index()
  const entry = (await index.get("old-name"))!
  const changed = await Stream.link({
    store,
    owners: { files: 1 },
    entries: (async function* () {
      yield { ...entry, id: "new-name", metadata: { mode: 0o755 }, chunks: index.chunks("old-name") }
    })(),
  })
  expect(bodyReads).toBe(0)
  expect(bodyWrites).toBe(1)
  await using next = await Stream.open({ root: changed, store, directory: temporary.path })
  for await (const renamed of next.entries()) {
    expect(renamed.id).toBe("new-name")
    expect(renamed.metadata.mode).toBe(0o755)
    expect(Buffer.concat(await Array.fromAsync(renamed.content))).toEqual(Buffer.from(body))
  }
  expect(next.verified()).toBe(true)
  expect(bodyReads).toBe(1)
})

test("portable reference writers reject incomplete chunk totals before returning a complete root", async () => {
  let reads = 0
  const store = {
    async put() {},
    async get() {
      reads++
      throw new Error("Metadata composition must not fetch bodies")
    },
  }
  await expect(
    Stream.link({
      store,
      owners: { files: 1 },
      entries: (async function* () {
        yield {
          id: "file",
          kind: "file" as const,
          metadata: {},
          hash: "a".repeat(64),
          bytes: 2,
          chunks: (async function* () {
            yield { hash: "b".repeat(64), bytes: 1 }
          })(),
        }
      })(),
    }),
  ).rejects.toThrow("totals")
  expect(reads).toBe(0)
})

test("a portable writer retains its original cancellation during an accepted object write", async () => {
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const body = new TextEncoder().encode("accepted bytes")
  const bodyHash = createHash("sha256").update(body).digest("hex")
  const controller = new AbortController()
  const store = {
    async put(hash: string) {
      if (hash !== bodyHash) return
      entered.resolve()
      await proceed.promise
    },
    async get(): Promise<Uint8Array> {
      throw new Error("Writer must not read content")
    },
  }
  const input = {
    store,
    owners: { files: 1 },
    signal: controller.signal as AbortSignal | undefined,
    entries: (async function* () {
      yield {
        id: "file",
        kind: "file" as const,
        metadata: {},
        content: (async function* () {
          yield body
        })(),
      }
    })(),
  }
  const pending = Stream.write(input)
  await entered.promise
  const reason = new Error("original writer cancelled")
  controller.abort(reason)
  input.signal = undefined
  proceed.resolve()
  await expect(pending).rejects.toBe(reason)
})

test.each(["write", "link"] as const)("%s snapshots nested entry metadata before writing its chunks", async (mode) => {
  await using temporary = await tmpdir()
  const objects = new Map<string, Uint8Array>()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let held = true
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      if (held) {
        held = false
        entered.resolve()
        await proceed.promise
      }
      objects.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      const bytes = objects.get(hash)
      if (!bytes || bytes.length > maximum) throw new Error("Missing or oversized object")
      return bytes.slice()
    },
  }
  const metadata = { key: ["session", "original-owner"], nested: { value: "original" } }
  const body = new TextEncoder().encode("body")
  const common = { store, owners: { files: 1 } }
  const pending =
    mode === "write"
      ? Stream.write({
          ...common,
          entries: (async function* () {
            yield {
              id: "file",
              kind: "file" as const,
              metadata,
              content: (async function* () {
                yield body
              })(),
            }
          })(),
        })
      : Stream.link({
          ...common,
          entries: (async function* () {
            yield {
              id: "file",
              kind: "file" as const,
              metadata,
              bytes: body.length,
              hash: createHash("sha256").update(body).digest("hex"),
              chunks: (async function* () {
                yield { hash: createHash("sha256").update(body).digest("hex"), bytes: body.length }
              })(),
            }
          })(),
        })
  await entered.promise
  metadata.key[1] = "later-owner"
  metadata.nested.value = "later"
  proceed.resolve()
  await using reader = await Stream.open({ root: await pending, store, directory: temporary.path })
  const index = await reader.index()
  expect((await index.get("file"))?.metadata).toEqual({
    key: ["session", "original-owner"],
    nested: { value: "original" },
  })
})

test.each(["write", "link"] as const)(
  "%s does not start a producer after its original signal was already cancelled",
  async (mode) => {
    const controller = new AbortController()
    const reason = new Error("cancel before producer admission")
    controller.abort(reason)
    let started = 0
    const common = {
      signal: controller.signal,
      owners: { files: 1 },
      store: {
        async put() {},
        async get(): Promise<Uint8Array> {
          throw new Error("No body read")
        },
      },
    }
    const result =
      mode === "write"
        ? Stream.write({
            ...common,
            entries: (async function* (): AsyncGenerator<Stream.Input> {
              started++
            yield* []
            })(),
          })
        : Stream.link({
            ...common,
            entries: (async function* (): AsyncGenerator<Stream.Reference> {
              started++
            yield* []
            })(),
          })
    await expect(result).rejects.toBe(reason)
    expect(started).toBe(0)
  },
)
