import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

test("an indexed reader discards metadata returned after its original cancellation", async () => {
  await using temporary = await tmpdir()
  const objects = new Map<string, Uint8Array>()
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      objects.set(hash, bytes.slice())
    },
    async get(hash: string) {
      return objects.get(hash)!.slice()
    },
  }
  const root = await Stream.write({
    store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      yield { id: "empty", kind: "record" as const, metadata: {}, content: (async function* () {})() }
    })(),
  })
  const began = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const controller = new AbortController()
  const reason = new Error("metadata read cancelled before completion")
  await using reader = await Stream.open({
    root,
    directory: temporary.path,
    signal: controller.signal,
    store: {
      put: store.put,
      async get() {
        began.resolve()
        await held.promise
        return new Uint8Array([255])
      },
    },
  })
  const pending = reader.index()
  await began.promise
  controller.abort(reason)
  held.resolve()
  await expect(pending).rejects.toBe(reason)
  expect(reader.verified()).toBe(false)
})

test("portable metadata indexing crosses pages without fetching file bodies and reads only the selected file", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "objects")
  await fs.mkdir(directory)
  const contentHashes = new Set<string>()
  let contentReads = 0
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      await Bun.write(path.join(directory, hash), bytes)
    },
    async get(hash: string, maximum: number) {
      if (contentHashes.has(hash)) contentReads++
      const file = Bun.file(path.join(directory, hash))
      if (file.size > maximum) throw new Error("Object exceeds its frame")
      return new Uint8Array(await file.arrayBuffer())
    },
  }
  const root = await Stream.write({
    store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      for (let position = 0; position < 513; position++) {
        const value = new TextEncoder().encode(`body-${position}`)
        contentHashes.add(createHash("sha256").update(value).digest("hex"))
        yield {
          id: `files/${String(position).padStart(6, "0")}`,
          kind: "file" as const,
          metadata: { version: 1, kind: "file", mode: 0o644 },
          content: (async function* () {
            yield value
          })(),
        }
      }
    })(),
  })
  await using reader = await Stream.open({ root, store, directory: temporary.path })
  const index = await reader.index()
  let count = 0
  for await (const entry of index.entries()) {
    expect(entry.kind).toBe("file")
    count++
  }
  expect(count).toBe(513)
  expect(contentReads).toBe(0)
  expect(reader.verified()).toBe(false)
  expect((await index.get("files/000512"))?.metadata.mode).toBe(0o644)
  expect(await index.get("missing")).toBeUndefined()
  const selected: string[] = []
  for await (const entry of index.entries({ prefix: "files/00051", after: "files/000510" })) selected.push(entry.id)
  expect(selected).toEqual(["files/000511", "files/000512"])
  const chunks: Uint8Array[] = []
  for await (const chunk of index.read("files/000512")) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString()).toBe("body-512")
  expect(contentReads).toBe(1)
  await reader.close()
  await expect(index.get("files/000512")).rejects.toThrow("closed")
})

test("indexed byte windows seek exact chunks and reject incomplete metadata and changed content", async () => {
  await using temporary = await tmpdir()
  const objects = new Map<string, Uint8Array>()
  const bodyHashes = new Set<string>()
  let bodyReads = 0
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      objects.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      if (bodyHashes.has(hash)) bodyReads++
      const bytes = objects.get(hash)
      if (!bytes || bytes.byteLength > maximum) throw new Error("Missing or oversized object")
      return bytes.slice()
    },
  }
  const bytes = new Uint8Array(Stream.chunkBytes * 2 + 17).fill(7)
  bytes.fill(9, bytes.length - 31)
  for (let offset = 0; offset < bytes.length; offset += Stream.chunkBytes)
    bodyHashes.add(
      createHash("sha256")
        .update(bytes.subarray(offset, offset + Stream.chunkBytes))
        .digest("hex"),
    )
  const root = await Stream.write({
    store,
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      yield {
        id: "large",
        kind: "file" as const,
        metadata: { version: 1, kind: "file", mode: 0o644 },
        content: (async function* () {
          yield bytes
        })(),
      }
    })(),
  })
  await using malformed = await Stream.open({
    root: { ...root, bytes: root.bytes + 1 },
    store,
    directory: temporary.path,
  })
  await expect(malformed.index()).rejects.toThrow("totals")
  expect(bodyReads).toBe(0)
  await using reader = await Stream.open({ root, store, directory: temporary.path })
  const index = await reader.index()
  const chunks: Uint8Array[] = []
  const offset = Stream.chunkBytes - 3
  for await (const chunk of index.read("large", { offset, length: 11 })) chunks.push(chunk)
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes.subarray(offset, offset + 11)))
  expect(bodyReads).toBe(2)
  const first = [...bodyHashes][0]!
  objects.set(first, new Uint8Array(Stream.chunkBytes).fill(1))
  await expect(
    (async () => {
      for await (const _chunk of index.read("large")) {
      }
    })(),
  ).rejects.toThrow("checksum")
  expect(reader.verified()).toBe(false)
})

test("indexed reads retain their selected window and reject bytes returned after original cancellation", async () => {
  await using temporary = await tmpdir()
  const objects = new Map<string, Uint8Array>()
  const body = new TextEncoder().encode("original file")
  const bodyHash = createHash("sha256").update(body).digest("hex")
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let held = false
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      objects.set(hash, bytes.slice())
    },
    async get(hash: string, maximum: number) {
      if (held && hash === bodyHash) {
        entered.resolve()
        await proceed.promise
      }
      const bytes = objects.get(hash)
      if (!bytes || bytes.byteLength > maximum) throw new Error("Missing or oversized object")
      return bytes.slice()
    },
  }
  const root = await Stream.write({
    store,
    owners: { fixture: 1 },
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
  })
  const controller = new AbortController()
  const input: Parameters<typeof Stream.open>[0] = { root, store, signal: controller.signal, directory: temporary.path }
  await using reader = await Stream.open(input)
  const index = await reader.index()
  const range = { offset: 0, length: 8 }
  const selected = index.read("file", range)
  range.offset = 9
  range.length = 4
  expect(Buffer.concat(await Array.fromAsync(selected)).toString()).toBe("original")
  held = true
  const pending = index.read("file").next()
  await entered.promise
  const reason = new Error("original index owner cancelled")
  controller.abort(reason)
  input.signal = undefined
  proceed.resolve()
  await expect(pending).rejects.toBe(reason)
  expect(reader.verified()).toBe(false)
})
