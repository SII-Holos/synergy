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

  async function get<T>(store: BlobStore, key: string, schema: z.ZodType<T>) {
    Hash.parse(key)
    const bytes = await store.get(key, pageBytes)
    if (bytes.length > pageBytes || hash(bytes) !== key)
      throw new Rejected({ message: "Portable manifest page checksum mismatch" })
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  }

  export async function write(input: {
    store: BlobStore
    entries: AsyncIterable<Input>
    owners: Root["owners"]
    signal?: AbortSignal
  }): Promise<Root> {
    let head: string | null = null
    let pages = 0
    let entries = 0
    let bytes = 0
    let pending: z.infer<typeof Entry>[] = []
    let pendingBytes = 1024
    const buffer = new Uint8Array(chunkBytes)
    async function flush() {
      if (!pending.length) return
      head = await put(
        input.store,
        Page.parse({ version: 2, kind: "entries", index: pages, previous: head, items: pending }),
      )
      pages = count(pages, 1)
      pending = []
      pendingBytes = 1024
    }
    for await (const entry of input.entries) {
      input.signal?.throwIfAborted()
      const digest = createHash("sha256")
      let chunkHead: string | null = null
      let chunkPages = 0
      let chunks = 0
      let size = 0
      let chunkList: z.infer<typeof Chunk>[] = []
      let buffered = 0
      async function flushList() {
        if (!chunkList.length) return
        chunkHead = await put(
          input.store,
          ChunkPage.parse({ version: 2, kind: "chunks", index: chunkPages, previous: chunkHead, items: chunkList }),
        )
        chunkPages = count(chunkPages, 1)
        chunkList = []
      }
      async function flushChunk() {
        if (!buffered) return
        const content = buffer.slice(0, buffered)
        const key = hash(content)
        await input.store.put(key, content)
        chunkList.push({ hash: key, bytes: content.length })
        chunks = count(chunks, 1)
        buffered = 0
        if (chunkList.length === pageItems) await flushList()
      }
      for await (const content of entry.content) {
        input.signal?.throwIfAborted()
        digest.update(content)
        size = count(size, content.length)
        let offset = 0
        while (offset < content.length) {
          const length = Math.min(chunkBytes - buffered, content.length - offset)
          buffer.set(content.subarray(offset, offset + length), buffered)
          buffered += length
          offset += length
          if (buffered === chunkBytes) await flushChunk()
        }
      }
      await flushChunk()
      await flushList()
      const descriptor = Entry.parse({
        id: entry.id,
        kind: entry.kind,
        metadata: entry.metadata,
        bytes: size,
        hash: digest.digest("hex"),
        chunks: { pages: chunkPages, count: chunks, head: chunkHead },
      })
      const descriptorBytes = encode(descriptor).length
      if (descriptorBytes > pageBytes / 2)
        throw new Rejected({ message: "Portable entry metadata exceeds its frame size" })
      if (pendingBytes + descriptorBytes + 1 > pageBytes) await flush()
      pending.push(descriptor)
      pendingBytes += descriptorBytes + 1
      entries = count(entries, 1)
      bytes = count(bytes, size)
      if (pending.length === pageItems) await flush()
    }
    await flush()
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

  export async function open(input: { root: Root; store: BlobStore; directory: string; signal?: AbortSignal }) {
    const root = Root.parse(input.root)
    const directory = await fs.mkdtemp(path.join(input.directory, "portable-reader-"))
    const database = new Database(path.join(directory, "index.sqlite"))
    database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048")
    database.exec(
      "CREATE TABLE pages (kind TEXT NOT NULL, position INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(kind, position)); CREATE TABLE identities (id TEXT PRIMARY KEY)",
    )
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
    async function index<T extends { index: number; previous: string | null }>(
      chain: z.infer<typeof Chain>,
      schema: z.ZodType<T>,
      prefix: string,
    ) {
      let key = chain.head
      for (let position = chain.pages - 1; position >= 0; position--) {
        input.signal?.throwIfAborted()
        if (!key) throw new Rejected({ message: "Portable page chain ended early" })
        const page = await get(input.store, key, schema)
        if (page.index !== position) throw new Rejected({ message: "Portable page order is inconsistent" })
        addPage.run(prefix, position, key)
        key = page.previous
      }
      if (key) throw new Rejected({ message: "Portable page chain has trailing pages" })
    }
    async function* pages<T>(length: number, schema: z.ZodType<T>, prefix: string) {
      for (let position = 0; position < length; position++) {
        input.signal?.throwIfAborted()
        const record = readPage.get(prefix, position)
        if (!record) throw new Rejected({ message: "Portable page index is incomplete" })
        yield await get(input.store, record.hash, schema)
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
          input.signal?.throwIfAborted()
          if (addIdentity.run(entry.id).changes !== 1)
            throw new Rejected({ message: "Duplicate portable entry identity" })
          await index(entry.chunks, ChunkPage, "chunk-")
          let consumed = false
          async function* content() {
            if (consumed) throw new Rejected({ message: "Portable entry content is single-use" })
            consumed = true
            const digest = createHash("sha256")
            let size = 0
            let chunks = 0
            for await (const list of pages(entry.chunks.pages, ChunkPage, "chunk-"))
              for (const chunk of list.items) {
                input.signal?.throwIfAborted()
                const data = await input.store.get(chunk.hash, chunk.bytes)
                if (data.length !== chunk.bytes || hash(data) !== chunk.hash)
                  throw new Rejected({ message: "Portable content chunk checksum mismatch" })
                size = count(size, data.length)
                chunks = count(chunks, 1)
                digest.update(data)
                yield data
              }
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
      database.exec("COMMIT")
      verified = true
    }
    async function close() {
      if (closed) return
      closed = true
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
    return { root, entries, verified: () => verified, close, [Symbol.asyncDispose]: close }
  }
}
