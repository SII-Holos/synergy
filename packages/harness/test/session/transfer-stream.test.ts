import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

async function fixture() {
  const root = await tmpdir()
  const directory = path.join(root.path, "objects")
  await fs.mkdir(directory)
  return {
    directory: root.path,
    store: {
      async put(hash: string, bytes: Uint8Array) {
        await Bun.write(path.join(directory, hash), bytes)
      },
      async get(hash: string, maximumBytes: number) {
        const file = Bun.file(path.join(directory, hash))
        if (file.size > maximumBytes) throw new Error("Oversized object")
        return new Uint8Array(await file.arrayBuffer())
      },
    },
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

test("a portable reader preserves its original cancellation after the caller changes its input", async () => {
  await using f = await fixture()
  const root = await Stream.write({
    store: f.store,
    owners: { harness: 2 },
    entries: (async function* () {
      yield {
        id: "record",
        kind: "record" as const,
        metadata: {},
        content: (async function* () {
          yield new TextEncoder().encode("original")
        })(),
      }
    })(),
  })
  const controller = new AbortController()
  const input: { root: Stream.Root; store: typeof f.store; directory: string; signal?: AbortSignal } = {
    root,
    store: f.store,
    directory: f.directory,
    signal: controller.signal,
  }
  await using reader = await Stream.open(input)
  const reason = new Error("original portable reader cancelled")
  controller.abort(reason)
  input.signal = undefined
  await expect(
    (async () => {
      for await (const entry of reader.entries())
        for await (const _chunk of entry.content) {
        }
    })(),
  ).rejects.toBe(reason)
  expect(reader.verified()).toBe(false)
})

test("a portable reader does not yield bytes returned after its original cancellation", async () => {
  await using f = await fixture()
  const data = new TextEncoder().encode("original chunk")
  const contentHash = createHash("sha256").update(data).digest("hex")
  const root = await Stream.write({
    store: f.store,
    owners: { harness: 2 },
    entries: (async function* () {
      yield {
        id: "record",
        kind: "record" as const,
        metadata: {},
        content: (async function* () {
          yield data
        })(),
      }
    })(),
  })
  let began!: () => void
  const reading = new Promise<void>((resolve) => {
    began = resolve
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new AbortController()
  await using reader = await Stream.open({
    root,
    directory: f.directory,
    signal: controller.signal,
    store: {
      put: f.store.put,
      async get(hash, bytes) {
        const result = await f.store.get(hash, bytes)
        if (hash === contentHash) {
          began()
          await held
        }
        return result
      },
    },
  })
  const entries = reader.entries()
  const first = await entries.next()
  if (first.done) throw new Error("Missing original entry")
  const chunks = first.value.content[Symbol.asyncIterator]()
  const pending = chunks.next()
  await reading
  const reason = new Error("original cancellation during chunk read")
  controller.abort(reason)
  release()
  await expect(pending).rejects.toBe(reason)
  expect(reader.verified()).toBe(false)
})

test("mutating a portable reader's public root cannot replace its original verified package", async () => {
  await using f = await fixture()
  const root = await Stream.write({
    store: f.store,
    owners: { harness: 2 },
    entries: (async function* () {
      yield { id: "original", kind: "record" as const, metadata: {}, content: (async function* () {})() }
    })(),
  })
  await using reader = await Stream.open({ root, store: f.store, directory: f.directory })
  for (const [key, value] of Object.entries({ pages: 0, head: null, entries: 0, bytes: 0 }))
    Reflect.set(reader.root, key, value)
  const seen: string[] = []
  for await (const entry of reader.entries()) {
    seen.push(entry.id)
    for await (const _chunk of entry.content) {
    }
  }
  expect(seen).toEqual(["original"])
  expect(reader.verified()).toBe(true)
})

test("paged portable manifests stream records and bytes beyond the previous total object quota", async () => {
  await using f = await fixture()
  const count = 100_001
  async function* entries() {
    for (let index = 0; index < count; index++)
      yield {
        id: `record-${index}`,
        kind: "record" as const,
        metadata: { key: ["sessions", "scope", "session", "inbox", String(index)] },
        content: (async function* () {})(),
      }
  }
  const root = await Stream.write({ store: f.store, entries: entries(), owners: { harness: 2 } })
  expect(root.entries).toBe(count)
  expect(root.pages).toBeGreaterThan(1)
  await using reader = await Stream.open({ root, store: f.store, directory: f.directory })
  let seen = 0
  for await (const entry of reader.entries()) {
    expect(entry.id).toBe(`record-${seen++}`)
    for await (const _chunk of entry.content) throw new Error("Expected an empty retained record")
  }
  expect(reader.verified()).toBe(true)
  expect(seen).toBe(count)
}, 60_000)

test("portable chunks preserve complete bytes and reject tampered manifests and duplicate identities", async () => {
  await using f = await fixture()
  const bytes = crypto.getRandomValues(new Uint8Array(48_000))
  const root = await Stream.write({
    store: f.store,
    owners: { harness: 2 },
    entries: (async function* () {
      yield {
        id: "artifact",
        kind: "artifact" as const,
        metadata: { key: ["assets", "fixture"] },
        content: (async function* () {
          yield bytes.subarray(0, 10)
          yield bytes.subarray(10)
        })(),
      }
    })(),
  })
  await using reader = await Stream.open({ root, store: f.store, directory: f.directory })
  const actual: Uint8Array[] = []
  for await (const entry of reader.entries()) for await (const chunk of entry.content) actual.push(chunk)
  expect(Buffer.concat(actual)).toEqual(Buffer.from(bytes))
  expect(reader.verified()).toBe(true)
  await using tampered = await Stream.open({
    root: { ...root, bytes: root.bytes + 1 },
    store: f.store,
    directory: f.directory,
  })
  await expect(
    (async () => {
      for await (const entry of tampered.entries())
        for await (const _chunk of entry.content) {
        }
    })(),
  ).rejects.toThrow("totals")
  const duplicate = await Stream.write({
    store: f.store,
    owners: { harness: 2 },
    entries: (async function* () {
      for (let index = 0; index < 2; index++)
        yield { id: "same", kind: "record" as const, metadata: {}, content: (async function* () {})() }
    })(),
  })
  await using repeated = await Stream.open({ root: duplicate, store: f.store, directory: f.directory })
  await expect(
    (async () => {
      for await (const entry of repeated.entries())
        for await (const _chunk of entry.content) {
        }
    })(),
  ).rejects.toThrow("Duplicate")
})
