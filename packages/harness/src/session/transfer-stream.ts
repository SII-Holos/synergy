import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Database } from "bun:sqlite"
import type { BlobStore } from "../storage/blobs"
import { JsonValue } from "../util/json-value"

export namespace SessionTransferStream {
  export const Rejected = NamedError.create("PortableSessionTransferRejected", z.object({ message: z.string() }))
  export const chunkBytes = 4 * 1024 * 1024
  export const pageBytes = 1024 * 1024
  const pageItems = 256
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Count = z.number().int().nonnegative().safe()
  const Chain = z
    .strictObject({ pages: Count, head: Hash.nullable() })
    .refine((value) => (value.pages === 0) === (value.head === null))
  const Chunks = Chain.safeExtend({ count: Count })
  const Entry = z.strictObject({
    id: z.string().min(1).max(4096),
    kind: z.enum(["record", "artifact", "file", "history"]),
    metadata: z.record(z.string(), JsonValue),
    bytes: Count,
    hash: Hash,
    chunks: Chunks,
  })
  const InputHeader = Entry.omit({ bytes: true, hash: true, chunks: true })
  const ReferenceHeader = Entry.omit({ chunks: true })
  const Page = z.strictObject({
    version: z.literal(2),
    kind: z.literal("entries"),
    index: Count,
    previous: Hash.nullable(),
    items: z.array(Entry).min(1).max(pageItems),
  })
  const Chunk = z.strictObject({ hash: Hash, bytes: z.number().int().positive().max(chunkBytes) })
  const ChunkPage = z.strictObject({
    version: z.literal(2),
    kind: z.literal("chunks"),
    index: Count,
    previous: Hash.nullable(),
    items: z.array(Chunk).min(1).max(pageItems),
  })
  export const Root = Chain.safeExtend({
    format: z.literal("synergy-portable-session"),
    version: z.literal(2),
    complete: z.literal(true),
    entries: Count,
    bytes: Count,
    owners: z.record(z.string().min(1), z.number().int().positive().safe()),
  })
  export type Root = z.infer<typeof Root>
  export interface Input {
    id: string
    kind: z.infer<typeof Entry>["kind"]
    metadata: z.infer<typeof Entry>["metadata"]
    content: AsyncIterable<Uint8Array>
  }
  export type Output = Omit<z.infer<typeof Entry>, "chunks"> & { content: AsyncIterable<Uint8Array> }
  export type Descriptor = Omit<z.infer<typeof Entry>, "chunks">
  export type Reference = Descriptor & { chunks: AsyncIterable<z.infer<typeof Chunk>> }
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  export const digest = (root: Root) => hash(encode(Root.parse(root)))
  const count = (first: number, second: number) => Count.parse(first + second)

  async function put(store: BlobStore, value: unknown) {
    const bytes = encode(value)
    if (bytes.length > pageBytes) throw new Rejected({ message: "Portable manifest page exceeds its frame size" })
    const key = hash(bytes)
    await store.put(key, bytes)
    return key
  }

  type Writer = { store: BlobStore; owners: Root["owners"]; signal?: AbortSignal }
  function writer(input: Writer): Writer {
    const signal = input.signal
    signal?.throwIfAborted()
    const provider = input.store
    return {
      store: { put: provider.put.bind(provider), get: provider.get.bind(provider) },
      owners: Root.shape.owners.parse(input.owners),
      signal,
    }
  }
  async function catalog(input: Writer, source: AsyncIterable<z.infer<typeof Entry>>): Promise<Root> {
    let head: string | null = null
    let pages = 0
    let entries = 0
    let bytes = 0
    let pending: z.infer<typeof Entry>[] = []
    let pendingBytes = 1024
    async function flush() {
      if (!pending.length) return
      input.signal?.throwIfAborted()
      head = await put(
        input.store,
        Page.parse({ version: 2, kind: "entries", index: pages, previous: head, items: pending }),
      )
      input.signal?.throwIfAborted()
      pages = count(pages, 1)
      pending = []
      pendingBytes = 1024
    }
    input.signal?.throwIfAborted()
    for await (const descriptor of source) {
      input.signal?.throwIfAborted()
      const descriptorBytes = encode(descriptor).length
      if (descriptorBytes > pageBytes / 2)
        throw new Rejected({ message: "Portable entry metadata exceeds its frame size" })
      if (pendingBytes + descriptorBytes + 1 > pageBytes) await flush()
      pending.push(descriptor)
      pendingBytes += descriptorBytes + 1
      entries = count(entries, 1)
      bytes = count(bytes, descriptor.bytes)
      if (pending.length === pageItems) await flush()
    }
    await flush()
    input.signal?.throwIfAborted()
    return Root.parse({
      format: "synergy-portable-session",
      version: 2,
      complete: true,
      pages,
      head,
      entries,
      bytes,
      owners: input.owners,
    })
  }

  async function chunkChain(input: Writer, source: AsyncIterable<z.infer<typeof Chunk>>) {
    let head: string | null = null
    let pages = 0
    let chunks = 0
    let bytes = 0
    let pending: z.infer<typeof Chunk>[] = []
    async function flush() {
      if (!pending.length) return
      input.signal?.throwIfAborted()
      head = await put(
        input.store,
        ChunkPage.parse({ version: 2, kind: "chunks", index: pages, previous: head, items: pending }),
      )
      input.signal?.throwIfAborted()
      pages = count(pages, 1)
      pending = []
    }
    input.signal?.throwIfAborted()
    for await (const value of source) {
      input.signal?.throwIfAborted()
      const chunk = Chunk.parse(value)
      pending.push(chunk)
      chunks = count(chunks, 1)
      bytes = count(bytes, chunk.bytes)
      if (pending.length === pageItems) await flush()
    }
    await flush()
    input.signal?.throwIfAborted()
    return { chunks: { pages, count: chunks, head }, bytes }
  }

  export async function write(input: Writer & { entries: AsyncIterable<Input> }): Promise<Root> {
    const selected = writer(input)
    const buffer = new Uint8Array(chunkBytes)
    return catalog(
      selected,
      (async function* () {
        selected.signal?.throwIfAborted()
        for await (const entry of input.entries) {
          selected.signal?.throwIfAborted()
          const header = InputHeader.parse({
            id: entry.id,
            kind: entry.kind,
            metadata: entry.metadata,
          })
          header.metadata = Entry.shape.metadata.parse(JSON.parse(JSON.stringify(header.metadata)))
          const content = entry.content
          const digest = createHash("sha256")
          let buffered = 0
          const retained = await chunkChain(
            selected,
            (async function* () {
              async function save() {
                selected.signal?.throwIfAborted()
                const bytes = buffer.slice(0, buffered)
                const key = hash(bytes)
                digest.update(bytes)
                await selected.store.put(key, bytes)
                selected.signal?.throwIfAborted()
                buffered = 0
                return { hash: key, bytes: bytes.length }
              }
              for await (const bytes of content) {
                selected.signal?.throwIfAborted()
                let offset = 0
                while (offset < bytes.length) {
                  const length = Math.min(chunkBytes - buffered, bytes.length - offset)
                  buffer.set(bytes.subarray(offset, offset + length), buffered)
                  buffered += length
                  offset += length
                  if (buffered === chunkBytes) yield await save()
                }
              }
              if (buffered) yield await save()
            })(),
          )
          yield Entry.parse({ ...header, ...retained, hash: digest.digest("hex") })
        }
      })(),
    )
  }

  export async function link(input: Writer & { entries: AsyncIterable<Reference> }): Promise<Root> {
    const selected = writer(input)
    return catalog(
      selected,
      (async function* () {
        selected.signal?.throwIfAborted()
        for await (const entry of input.entries) {
          selected.signal?.throwIfAborted()
          const header = ReferenceHeader.parse({
            id: entry.id,
            kind: entry.kind,
            metadata: entry.metadata,
            bytes: entry.bytes,
            hash: entry.hash,
          })
          header.metadata = Entry.shape.metadata.parse(JSON.parse(JSON.stringify(header.metadata)))
          const retained = await chunkChain(selected, entry.chunks)
          if (retained.bytes !== header.bytes)
            throw new Rejected({ message: "Portable reference chunk totals mismatch" })
          yield Entry.parse({ ...header, chunks: retained.chunks })
        }
      })(),
    )
  }

  export async function open(input: { root: Root; store: BlobStore; directory: string; signal?: AbortSignal }) {
    const selected = Root.parse(input.root)
    const root = Object.freeze({ ...selected, owners: Object.freeze(selected.owners) })
    const signal = input.signal
    signal?.throwIfAborted()
    const provider = input.store
    const store = Object.freeze({ put: provider.put.bind(provider), get: provider.get.bind(provider) })
    const directory = await fs.mkdtemp(path.join(input.directory, "portable-reader-"))
    const database = new Database(path.join(directory, "index.sqlite"))
    database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048")
    database.exec(
      "CREATE TABLE pages (kind TEXT NOT NULL, position INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(kind, position)); CREATE TABLE identities (id TEXT PRIMARY KEY)",
    )
    database.exec(
      "CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE chunks (id TEXT NOT NULL, ordinal INTEGER NOT NULL, offset INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(id, ordinal)); CREATE INDEX chunk_offsets ON chunks(id, offset)",
    )
    database.exec("CREATE TABLE objects (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL)")
    const objectSize = database.query<{ bytes: number }, [string]>("SELECT bytes FROM objects WHERE hash=?")
    const insertObject = database.query("INSERT OR IGNORE INTO objects VALUES (?,?)")
    const nextObject = database.query<{ hash: string; bytes: number }, [string]>(
      "SELECT hash,bytes FROM objects WHERE hash>? ORDER BY hash LIMIT 1",
    )
    function object(key: string, bytes: number) {
      const previous = objectSize.get(key)
      if (previous && previous.bytes !== bytes) throw new Rejected({ message: "Portable object size conflict" })
      insertObject.run(key, bytes)
    }
    database.exec("BEGIN")
    const addPage = database.query("INSERT INTO pages (kind, position, hash) VALUES (?, ?, ?)")
    const readPage = database.query<{ hash: string }, [string, number]>(
      "SELECT hash FROM pages WHERE kind = ? AND position = ?",
    )
    const removePage = database.query("DELETE FROM pages WHERE kind = ? AND position = ?")
    const addIdentity = database.query("INSERT OR IGNORE INTO identities (id) VALUES (?)")
    let verified = false
    let started = false
    let closed = false
    let indexed = false
    function assertOpen() {
      if (closed) throw new Rejected({ message: "Portable reader is closed" })
      signal?.throwIfAborted()
    }
    async function read<T>(key: string, schema: z.ZodType<T>) {
      assertOpen()
      Hash.parse(key)
      const bytes = await store.get(key, pageBytes)
      assertOpen()
      if (bytes.length > pageBytes || hash(bytes) !== key)
        throw new Rejected({ message: "Portable manifest page checksum mismatch" })
      const value = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
      object(key, bytes.byteLength)
      return value
    }
    async function index<T extends { index: number; previous: string | null }>(
      chain: z.infer<typeof Chain>,
      schema: z.ZodType<T>,
      prefix: string,
    ) {
      let key = chain.head
      for (let position = chain.pages - 1; position >= 0; position--) {
        assertOpen()
        if (!key) throw new Rejected({ message: "Portable page chain ended early" })
        const page = await read(key, schema)
        if (page.index !== position) throw new Rejected({ message: "Portable page order is inconsistent" })
        addPage.run(prefix, position, key)
        key = page.previous
      }
      if (key) throw new Rejected({ message: "Portable page chain has trailing pages" })
    }
    async function* pages<T>(length: number, schema: z.ZodType<T>, prefix: string) {
      for (let position = 0; position < length; position++) {
        assertOpen()
        const record = readPage.get(prefix, position)
        if (!record) throw new Rejected({ message: "Portable page index is incomplete" })
        yield await read(record.hash, schema)
        assertOpen()
        removePage.run(prefix, position)
      }
    }
    async function* entries(): AsyncGenerator<Output> {
      if (started || closed) throw new Rejected({ message: "Portable reader is single-use" })
      started = true
      await index(root, Page, "page-")
      let received = 0
      let totalBytes = 0
      for await (const page of pages(root.pages, Page, "page-"))
        for (const entry of page.items) {
          assertOpen()
          if (addIdentity.run(entry.id).changes !== 1)
            throw new Rejected({ message: "Duplicate portable entry identity" })
          await index(entry.chunks, ChunkPage, "chunk-")
          let consumed = false
          async function* content() {
            if (consumed) throw new Rejected({ message: "Portable entry content is single-use" })
            assertOpen()
            consumed = true
            const digest = createHash("sha256")
            let size = 0
            let chunks = 0
            for await (const list of pages(entry.chunks.pages, ChunkPage, "chunk-"))
              for (const chunk of list.items) {
                assertOpen()
                const data = await store.get(chunk.hash, chunk.bytes)
                assertOpen()
                if (data.length !== chunk.bytes || hash(data) !== chunk.hash)
                  throw new Rejected({ message: "Portable content chunk checksum mismatch" })
                size = count(size, data.length)
                chunks = count(chunks, 1)
                digest.update(data)
                yield data
              }
            assertOpen()
            if (size !== entry.bytes || chunks !== entry.chunks.count || digest.digest("hex") !== entry.hash)
              throw new Rejected({ message: "Portable entry totals or checksum mismatch" })
            totalBytes = count(totalBytes, size)
            received = count(received, 1)
          }
          const stream = content()
          yield {
            id: entry.id,
            kind: entry.kind,
            metadata: entry.metadata,
            bytes: entry.bytes,
            hash: entry.hash,
            content: stream,
          }
          if (!consumed || received <= 0 || totalBytes > root.bytes)
            throw new Rejected({ message: "Portable entry content was not completely consumed" })
          const completion = await stream.next()
          if (!completion.done) throw new Rejected({ message: "Portable entry content was not completely consumed" })
        }
      if (received !== root.entries || totalBytes !== root.bytes)
        throw new Rejected({ message: "Portable manifest totals mismatch" })
      assertOpen()
      database.exec("COMMIT")
      verified = true
    }
    const putEntry = database.query("INSERT INTO entries (id, value) VALUES (?, ?)")
    const putChunk = database.query("INSERT INTO chunks (id, ordinal, offset, hash, bytes) VALUES (?, ?, ?, ?, ?)")
    const getEntry = database.query<{ value: string }, [string]>("SELECT value FROM entries WHERE id = ?")
    const nextEntry = database.query<{ id: string; value: string }, [string, string, string, string]>(
      "SELECT id, value FROM entries WHERE id >= MAX(?, ?, ?) AND id != ? ORDER BY id LIMIT 1",
    )
    type ChunkRow = { ordinal: number; offset: number; hash: string; bytes: number }
    const firstChunk = database.query<ChunkRow, [string, number]>(
      "SELECT ordinal, offset, hash, bytes FROM chunks WHERE id = ? AND offset <= ? ORDER BY offset DESC LIMIT 1",
    )
    const chunkRows = database.query<ChunkRow, [string, number, number]>(
      "SELECT ordinal, offset, hash, bytes FROM chunks WHERE id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?",
    )
    function indexedChunks(id: string) {
      return (async function* () {
        const entry = await indexedEntry(id)
        if (!entry) throw new Rejected({ message: "Portable entry is absent" })
        let ordinal = -1
        for (;;) {
          assertIndexed()
          const rows = chunkRows.all(id, ordinal, pageItems)
          if (!rows.length) return
          for (const row of rows) {
            assertIndexed()
            ordinal = row.ordinal
            yield { hash: row.hash, bytes: row.bytes }
          }
        }
      })()
    }
    function assertIndexed() {
      assertOpen()
      if (!indexed) throw new Rejected({ message: "Portable metadata index is incomplete" })
    }
    function descriptor(value: string): Descriptor {
      const { chunks: _chunks, ...entry } = Entry.parse(JSON.parse(value))
      return entry
    }
    async function indexedEntry(id: string) {
      assertIndexed()
      const row = getEntry.get(id)
      return row ? descriptor(row.value) : undefined
    }
    function indexedEntries(
      options: { after?: string; prefix?: string; from?: string } = {},
    ): AsyncGenerator<Descriptor> {
      const after = options.after
      const prefix = options.prefix
      const from = options.from
      return (async function* () {
        let cursor = after ?? ""
        while (true) {
          assertIndexed()
          const row = nextEntry.get(prefix ?? "", from ?? "", cursor, cursor)
          if (!row) return
          cursor = row.id
          if (prefix !== undefined && !row.id.startsWith(prefix)) return
          yield descriptor(row.value)
        }
      })()
    }
    function indexedContent(id: string, options: { offset?: number; length?: number } = {}) {
      const selectedID = id
      const offset = Count.parse(options.offset ?? 0)
      const length = options.length === undefined ? undefined : Count.parse(options.length)
      return (async function* () {
        const entry = await indexedEntry(selectedID)
        assertIndexed()
        if (!entry) throw new Rejected({ message: "Portable entry is absent" })
        const start = Math.min(offset, entry.bytes)
        const end = start + Math.min(length ?? entry.bytes - start, entry.bytes - start)
        const complete = offset === 0 && end === entry.bytes
        const digest = complete ? createHash("sha256") : undefined
        const first = firstChunk.get(selectedID, offset)
        let ordinal = (first?.ordinal ?? 0) - 1
        let received = 0
        while (offset + received < end) {
          assertIndexed()
          const rows = chunkRows.all(selectedID, ordinal, pageItems)
          if (!rows.length) throw new Rejected({ message: "Portable indexed content is incomplete" })
          for (const row of rows) {
            assertIndexed()
            ordinal = row.ordinal
            if (row.offset >= end) break
            const data = await store.get(row.hash, row.bytes)
            assertIndexed()
            if (data.length !== row.bytes || hash(data) !== row.hash)
              throw new Rejected({ message: "Portable content chunk checksum mismatch" })
            const bytes = data.subarray(Math.max(0, offset - row.offset), Math.min(row.bytes, end - row.offset))
            digest?.update(bytes)
            received = count(received, bytes.byteLength)
            yield bytes
            if (offset + received >= end) break
          }
        }
        assertIndexed()
        if (received !== Math.max(0, end - offset) || (digest && digest.digest("hex") !== entry.hash))
          throw new Rejected({ message: "Portable indexed content checksum mismatch" })
      })()
    }
    async function buildIndex() {
      if (started || closed) throw new Rejected({ message: "Portable reader is single-use" })
      started = true
      await index(root, Page, "page-")
      let received = 0
      let totalBytes = 0
      for await (const page of pages(root.pages, Page, "page-"))
        for (const entry of page.items) {
          assertOpen()
          if (addIdentity.run(entry.id).changes !== 1)
            throw new Rejected({ message: "Duplicate portable entry identity" })
          putEntry.run(entry.id, JSON.stringify(entry))
          await index(entry.chunks, ChunkPage, "chunk-")
          let size = 0
          let chunks = 0
          for await (const list of pages(entry.chunks.pages, ChunkPage, "chunk-"))
            for (const chunk of list.items) {
              assertOpen()
              putChunk.run(entry.id, chunks, size, chunk.hash, chunk.bytes)
              object(chunk.hash, chunk.bytes)
              chunks = count(chunks, 1)
              size = count(size, chunk.bytes)
            }
          if (size !== entry.bytes || chunks !== entry.chunks.count)
            throw new Rejected({ message: "Portable indexed entry totals mismatch" })
          received = count(received, 1)
          totalBytes = count(totalBytes, size)
        }
      assertOpen()
      if (received !== root.entries || totalBytes !== root.bytes)
        throw new Rejected({ message: "Portable indexed manifest totals mismatch" })
      database.exec("COMMIT")
      indexed = true
      function objects() {
        return (async function* () {
          let cursor = ""
          for (;;) {
            assertIndexed()
            const value = nextObject.get(cursor)
            if (!value) return
            cursor = value.hash
            yield value
          }
        })()
      }
      return Object.freeze({
        root,
        get: indexedEntry,
        entries: indexedEntries,
        chunks: indexedChunks,
        read: indexedContent,
        objects,
      })
    }
    async function close() {
      if (closed) return
      closed = true
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
    return { root, entries, index: buildIndex, verified: () => verified, close, [Symbol.asyncDispose]: close }
  }
}
