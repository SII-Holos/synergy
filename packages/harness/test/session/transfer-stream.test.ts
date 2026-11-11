import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
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
