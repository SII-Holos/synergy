import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { ReclaimableBlobStore } from "./blobs"
import { ArtifactLocation } from "./artifact-location"
import { StorageConflictError, StorageIntegrityError, StorageCommitUnknownError, NotFoundError } from "./errors"
import type { StoreTransaction, TransactionalStore } from "./transactional-store"

const chunkBytes = 4 * 1024 * 1024
const manifestBytes = 4 * 1024 * 1024
const retentionMs = 7 * 86_400_000
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const LegacyManifest = z
  .object({
    version: z.literal(1),
    size: z.number().int().nonnegative().safe(),
    sha256: Hash,
    chunks: z.array(z.object({ hash: Hash, size: z.number().int().positive().max(chunkBytes) }).strict()).max(32_768),
  })
  .strict()
  .refine((m) => m.chunks.reduce((sum, c) => sum + c.size, 0) === m.size, "Invalid artifact manifest size")
const Chunk = z.object({ hash: Hash, size: z.number().int().positive().max(chunkBytes) }).strict()
const Page = z
  .object({
    version: z.literal(2),
    index: z.number().int().nonnegative().safe(),
    previous: Hash.optional(),
    chunks: z.array(Chunk).min(1).max(128),
  })
  .strict()
const PagedManifest = z
  .object({
    version: z.literal(2),
    size: z.number().int().nonnegative().safe(),
    sha256: Hash,
    pageCount: z.number().int().nonnegative().safe(),
    chunkCount: z.number().int().nonnegative().safe(),
    tail: Hash.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.pageCount === 0) === (value.tail === undefined) && (value.chunkCount === 0) === (value.size === 0),
    "Invalid paged artifact manifest",
  )
const Manifest = z.discriminatedUnion("version", [LegacyManifest, PagedManifest])
const Catalog = z
  .object({ manifest: Manifest, unreferencedSince: z.number().optional(), deleting: z.boolean().optional() })
  .strict()
const Intent = z
  .object({ writerID: z.string().min(1), manifest: Hash.optional(), streamID: z.string().optional() })
  .strict()
  .refine((value) => !!value.manifest || !!value.streamID, "An artifact intent needs a manifest or stream")
const StoredPage = z.object({ hash: Hash, page: Page }).strict()
const Stream = z
  .object({ writerID: z.string(), unreferencedSince: z.number().optional(), deleting: z.boolean().optional() })
  .strict()
type Prepared = {
  location: ArtifactLocation
  intentID: string
  receipt: Readonly<{ operationID: string; requestHash: string }>
}

export interface ObjectArtifactOptions {
  /** A dedicated namespace prefix: these hashes must not overlap Workspace or other owners. */
  blobs: ReclaimableBlobStore
  /** Durable activation identity. Reuse only while the same physical writer remains authoritative. */
  writerID: string
  now?: () => number
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
function verify(bytes: Uint8Array, expected: string, maximum: number) {
  if (bytes.length > maximum) throw new StorageIntegrityError("Artifact exceeds its byte limit")
  if (hash(bytes) !== expected) throw new StorageIntegrityError("Artifact object checksum mismatch")
  return bytes
}
const catalogKey = (id: string) => ["storage_object_manifests", id]
const intentKey = (id: string) => ["storage_object_intents", id]
const streamKey = (id: string) => ["storage_object_streams", id]
const streamPin = (id: string, object: string) => ["storage_object_stream_pins", id, object]
const streamPage = (id: string, index: number) => ["storage_object_stream_pages", id, String(index).padStart(16, "0")]
const pageKey = (id: string, index: number) => ["storage_object_pages", id, String(index).padStart(16, "0")]
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** Used under Storage's artifact gate and the namespace's single-writer ownership. */
export class ObjectArtifacts {
  static readonly chunkBytes = chunkBytes
  private readonly released = new Set<string>()
  private readonly now: () => number

  constructor(
    private readonly store: TransactionalStore,
    private readonly options: ObjectArtifactOptions,
  ) {
    if (!options.writerID || options.writerID.length > 512)
      throw new StorageConflictError("Invalid artifact writer identity")
    this.now = options.now ?? Date.now
  }

  async prepare(bytes: Uint8Array): Promise<Prepared> {
    return this.prepareStream(
      (async function* () {
        yield bytes
      })(),
    )
  }

  async prepareStream(content: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Prepared> {
    signal?.throwIfAborted()
    const intentID = randomUUID()
    await this.store.transaction(async (tx) => {
      await tx.write(intentKey(intentID), { writerID: this.options.writerID, streamID: intentID })
      await tx.write(streamKey(intentID), { writerID: this.options.writerID })
    })
    let size = 0
    let chunkCount = 0
    let pageCount = 0
    let previous: string | undefined
    let chunks: z.infer<typeof Chunk>[] = []
    const checksum = createHash("sha256")
    const buffer = new Uint8Array(chunkBytes)
    let used = 0
    const put = async (id: string, bytes: Uint8Array) => {
      signal?.throwIfAborted()
      await this.store.transaction((tx) => tx.write(streamPin(intentID, id), { hash: id }))
      await this.options.blobs.put(id, bytes)
      signal?.throwIfAborted()
    }
    const flushPage = async () => {
      if (!chunks.length) return
      const page = Page.parse({ version: 2, index: pageCount, previous, chunks })
      const encoded = encode(page)
      const id = hash(encoded)
      await this.store.transaction((tx) => tx.write(streamPage(intentID, pageCount), { hash: id, page }))
      await put(id, encoded)
      previous = id
      pageCount++
      chunks = []
    }
    const flushChunk = async () => {
      if (!used) return
      const bytes = buffer.slice(0, used)
      const id = hash(bytes)
      await put(id, bytes)
      chunks.push({ hash: id, size: bytes.length })
      chunkCount++
      used = 0
      if (chunks.length === 128) await flushPage()
    }
    try {
      for await (const input of content) {
        signal?.throwIfAborted()
        if (!(input instanceof Uint8Array)) throw new StorageIntegrityError("Artifact stream must contain byte chunks")
        if (!Number.isSafeInteger(size + input.length))
          throw new StorageIntegrityError("Artifact stream byte count is not representable")
        size += input.length
        checksum.update(input)
        for (let offset = 0; offset < input.length;) {
          const length = Math.min(chunkBytes - used, input.length - offset)
          buffer.set(input.subarray(offset, offset + length), used)
          used += length
          offset += length
          if (used === chunkBytes) await flushChunk()
        }
      }
      await flushChunk()
      await flushPage()
      const manifest = PagedManifest.parse({
        version: 2,
        size,
        sha256: checksum.digest("hex"),
        pageCount,
        chunkCount,
        tail: previous,
      })
      const encoded = encode(manifest)
      const id = hash(encoded)
      await put(id, encoded)
      const receipt = Object.freeze({ operationID: `artifact-stream-prepare:${intentID}`, requestHash: id })
      const sealed = await this.store.transaction(async (tx) => {
        const old = await this.optional(tx, catalogKey(id))
        if (old && Catalog.parse(old).deleting) {
          await tx.remove(intentKey(intentID))
          await this.removeStream(tx, intentID)
          return false
        }
        for await (const row of this.records(tx, ["storage_object_stream_pages", intentID]))
          await tx.write(pageKey(id, Number(row.key.at(-1))), StoredPage.parse(row.value))
        await tx.write(catalogKey(id), { manifest })
        await tx.write(intentKey(intentID), { writerID: this.options.writerID, manifest: id })
        await this.removeStream(tx, intentID)
        return true
      }, receipt)
      if (!sealed) throw new StorageConflictError("Artifact is being reclaimed")
      return {
        intentID,
        receipt,
        location: ArtifactLocation.parse({
          pack: `${id}.pack`,
          blockOffset: 0,
          blockBytes: size,
          decodedBytes: size,
          offset: 0,
          size,
          codec: "raw",
          sha256: manifest.sha256,
        }),
      }
    } catch (error) {
      if (!(error instanceof StorageCommitUnknownError)) this.released.add(intentID)
      throw error
    }
  }

  async preparationReceipt(prepared: Prepared) {
    const actual = await this.store.operationReceipt(prepared.receipt.operationID)
    const success = z.strictObject({ value: z.literal(true) }).safeParse(actual?.result)
    if (!actual || actual.requestHash !== prepared.receipt.requestHash || !success.success)
      throw new StorageIntegrityError("Object preparation has no matching committed success receipt")
    return Object.freeze({ ...prepared.receipt, result: JSON.stringify(success.data) })
  }

  async publish(tx: StoreTransaction, prepared: Prepared) {
    const intent = Intent.parse(await tx.read(intentKey(prepared.intentID)))
    if (
      !intent.manifest ||
      intent.writerID !== this.options.writerID ||
      `${intent.manifest}.pack` !== prepared.location.pack
    )
      throw new StorageConflictError("Artifact preparation belongs to another writer")
    const catalog = Catalog.parse(await tx.read(catalogKey(intent.manifest)))
    if (catalog.deleting) throw new StorageConflictError("Artifact is being reclaimed")
    await tx.remove(intentKey(prepared.intentID))
    if (intent.streamID) await this.removeStream(tx, intent.streamID)
  }

  release(prepared: Prepared, outcome: "aborted" | "committed" | "unknown") {
    if (outcome !== "unknown") this.released.add(prepared.intentID)
  }

  private async manifest(location: ArtifactLocation) {
    const parsed = ArtifactLocation.parse(location)
    if (parsed.codec !== "raw" || parsed.blockOffset !== 0 || parsed.offset !== 0 || parsed.size !== parsed.blockBytes)
      throw new StorageIntegrityError("Artifact location requires offline object migration")
    const id = Hash.parse(parsed.pack.slice(0, -5))
    const bytes = verify(await this.options.blobs.get(id, manifestBytes), id, manifestBytes)
    const manifest = Manifest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    if (manifest.size !== parsed.size || manifest.sha256 !== parsed.sha256)
      throw new StorageIntegrityError("Artifact manifest does not match its committed reference")
    if (manifest.version === 2)
      await this.store.snapshot(async (tx) => {
        for await (const _page of this.pages(tx, id, manifest)) {
        }
      })
    return { id, manifest }
  }

  private async *pages(tx: StoreTransaction, id: string, manifest: z.infer<typeof PagedManifest>) {
    let previous: string | undefined
    let count = 0
    let size = 0
    for (let index = 0; index < manifest.pageCount; index++) {
      const stored = StoredPage.parse(await tx.read(pageKey(id, index)))
      if (stored.hash !== hash(encode(stored.page)) || stored.page.index !== index || stored.page.previous !== previous)
        throw new StorageIntegrityError("Artifact manifest page chain is inconsistent")
      previous = stored.hash
      count += stored.page.chunks.length
      for (const chunk of stored.page.chunks) size += chunk.size
      yield stored
    }
    if (previous !== manifest.tail || count !== manifest.chunkCount || size !== manifest.size)
      throw new StorageIntegrityError("Artifact manifest page closure is incomplete")
  }

  private async *chunks(id: string, manifest: z.infer<typeof Manifest>, signal?: AbortSignal) {
    if (manifest.version === 1) {
      yield* manifest.chunks
      return
    }
    for (let index = 0; index < manifest.pageCount; index++) {
      signal?.throwIfAborted()
      const stored = StoredPage.parse(await this.store.snapshot((tx) => tx.read(pageKey(id, index))))
      const bytes = verify(await this.options.blobs.get(stored.hash, manifestBytes), stored.hash, manifestBytes)
      const page = Page.parse(JSON.parse(new TextDecoder().decode(bytes)))
      if (page.index !== index) throw new StorageIntegrityError("Artifact manifest page identity changed")
      yield* page.chunks
    }
  }

  async *stream(location: ArtifactLocation, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted()
    const { id, manifest } = await this.manifest(location)
    const checksum = createHash("sha256")
    let size = 0
    for await (const chunk of this.chunks(id, manifest, signal)) {
      signal?.throwIfAborted()
      const bytes = verify(await this.options.blobs.get(chunk.hash, chunk.size), chunk.hash, chunk.size)
      if (bytes.length !== chunk.size) throw new StorageIntegrityError("Artifact chunk size mismatch")
      checksum.update(bytes)
      size += bytes.length
      signal?.throwIfAborted()
      yield bytes
    }
    if (size !== manifest.size || checksum.digest("hex") !== manifest.sha256)
      throw new StorageIntegrityError("Artifact checksum mismatch")
  }

  async read(location: ArtifactLocation, maximum?: number) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0 || location.size > maximum))
      throw new StorageIntegrityError("Artifact exceeds its byte limit")
    const output = new Uint8Array(location.size)
    let offset = 0
    for await (const bytes of this.stream(location)) {
      output.set(bytes, offset)
      offset += bytes.length
    }
    return output
  }

  async verify(location: ArtifactLocation) {
    for await (const _chunk of this.stream(location)) {
    }
  }

  async validate(options: { accept?: (key: string[]) => boolean; progress?: (count: number) => void }) {
    const validationID = randomUUID()
    const prefix = ["storage_object_validations", validationID]
    try {
      await this.store.transaction(async (tx) => {
        for await (const entry of tx.artifacts()) {
          if (options.accept && !options.accept(entry.key)) continue
          const id = Hash.parse(entry.location.pack.slice(0, -5))
          const catalog = Catalog.parse(await tx.read(catalogKey(id)))
          if (catalog.deleting) throw new StorageIntegrityError("A referenced artifact was marked for deletion")
          const intentID = `${validationID}-${id}`
          await tx.write(intentKey(intentID), { writerID: this.options.writerID, manifest: id })
          await tx.write([...prefix, "pins", intentID], true)
          await tx.write([...prefix, "entries", hash(encode(entry.key))], entry.location)
        }
      })
      let count = 0
      let after: string[] | undefined
      for (;;) {
        const rows = await this.store.snapshot((tx) =>
          tx.query<unknown>({ prefix: [...prefix, "entries"], after, limit: 100 }),
        )
        for (const row of rows) {
          await this.verify(ArtifactLocation.parse(row.value))
          count++
          if (count % 256 === 0) options.progress?.(count)
        }
        if (rows.length < 100) break
        after = rows.at(-1)!.key
      }
      options.progress?.(count)
      return count
    } finally {
      await this.store.transaction(async (tx) => {
        for await (const row of this.records(tx, [...prefix, "pins"])) await tx.remove(intentKey(row.key.at(-1)!))
        await tx.removeTree(prefix)
      })
    }
  }

  /** The caller must have confirmed physical stop and fenced this exact previous writer. */
  async retireWriter(writerID: string) {
    if (!writerID || writerID === this.options.writerID)
      throw new StorageConflictError("Cannot retire the current artifact writer")
    await this.store.transaction(async (tx) => {
      for await (const row of this.records(tx, ["storage_object_intents"]))
        if (Intent.parse(row.value).writerID === writerID) await tx.remove(row.key)
    })
  }

  private async optional(tx: StoreTransaction, key: string[]) {
    try {
      return await tx.read<unknown>(key)
    } catch (error) {
      if (error instanceof NotFoundError) return
      throw error
    }
  }

  private async *records(tx: StoreTransaction, prefix: string[]) {
    let after: string[] | undefined
    for (;;) {
      const page = await tx.query<unknown>({ prefix, after, limit: 256 })
      yield* page
      if (page.length < 256) return
      after = page.at(-1)!.key
    }
  }

  private async removeStream(tx: StoreTransaction, id: string) {
    await tx.remove(streamKey(id))
    await tx.removeTree(["storage_object_stream_pins", id])
    await tx.removeTree(["storage_object_stream_pages", id])
  }

  private async *hashes(tx: StoreTransaction, id: string, manifest: z.infer<typeof Manifest>) {
    yield id
    if (manifest.version === 1) {
      for (const chunk of manifest.chunks) yield chunk.hash
      return
    }
    for await (const page of this.pages(tx, id, manifest)) {
      yield page.hash
      for (const chunk of page.page.chunks) yield chunk.hash
    }
  }

  async collect(preparedPacks: Iterable<string>, progress?: (count: number) => void) {
    const collectionID = randomUUID()
    const released = [...this.released]
    const prefix = ["storage_object_collection", collectionID]
    const retained = (id: string) => [...prefix, "retained", id]
    const pinned = (id: string) => [...prefix, "packs", id]
    const activeStream = (id: string) => [...prefix, "streams", id]
    const candidates = [...prefix, "candidates"]
    await this.store.transaction(async (tx) => {
      await tx.removeTree(["storage_object_collection"])
      for (const id of released) await tx.remove(intentKey(id))
      for (const pack of preparedPacks) await tx.write(pinned(pack), true)
      for await (const pack of tx.artifactPacks()) await tx.write(pinned(pack), true)
      for await (const row of this.records(tx, ["storage_pack_pins"])) await tx.write(pinned(row.key[1]!), true)
      for await (const row of this.records(tx, ["storage_object_intents"])) {
        const intent = Intent.parse(row.value)
        if (intent.manifest) await tx.write(pinned(`${intent.manifest}.pack`), true)
        if (intent.streamID) await tx.write(activeStream(intent.streamID), true)
      }
      const now = this.now()
      for await (const row of this.records(tx, ["storage_object_manifests"])) {
        const id = Hash.parse(row.key[1])
        const value = Catalog.parse(row.value)
        if (hash(encode(value.manifest)) !== id)
          throw new StorageIntegrityError("Artifact catalog manifest identity changed")
        const live = !!(await this.optional(tx, pinned(`${id}.pack`)))
        if (live && value.deleting) throw new StorageIntegrityError("A referenced artifact was marked for deletion")
        const since = value.unreferencedSince ?? now
        if (live || (!value.deleting && now - since < retentionMs)) {
          if (live && value.unreferencedSince !== undefined) await tx.write(row.key, { manifest: value.manifest })
          else if (!live) await tx.write(row.key, { ...value, unreferencedSince: since })
          for await (const object of this.hashes(tx, id, value.manifest)) await tx.write(retained(object), true)
        } else {
          for await (const _object of this.hashes(tx, id, value.manifest)) {
          }
          await tx.write(row.key, { ...value, unreferencedSince: since, deleting: true })
          await tx.write([...candidates, "manifest", id], value)
        }
      }
      for await (const row of this.records(tx, ["storage_object_streams"])) {
        const id = row.key[1]!
        const value = Stream.parse(row.value)
        const live = !!(await this.optional(tx, activeStream(id)))
        if (live && value.deleting) throw new StorageIntegrityError("An active artifact stream was marked for deletion")
        const since = value.unreferencedSince ?? now
        if (live || (!value.deleting && now - since < retentionMs)) {
          await tx.write(row.key, live ? { writerID: value.writerID } : { ...value, unreferencedSince: since })
          for await (const pin of this.records(tx, ["storage_object_stream_pins", id]))
            await tx.write(retained(Hash.parse(pin.key.at(-1))), true)
        } else {
          await tx.write(row.key, { ...value, unreferencedSince: since, deleting: true })
          await tx.write([...candidates, "stream", id], value)
        }
      }
    })
    for (const id of released) this.released.delete(id)
    let removed = 0
    let after: string[] | undefined
    for (;;) {
      const rows = await this.store.snapshot((tx) => tx.query<unknown>({ prefix: candidates, after, limit: 100 }))
      for (const row of rows) {
        const id = row.key.at(-1)!
        const kind = row.key.at(-2)
        if (kind === "manifest") {
          const value = Catalog.parse(row.value)
          const objects = this.hashesOutside(id, value.manifest)
          for await (const object of objects) {
            const keep = await this.store.snapshot((tx) => this.optional(tx, retained(object)))
            if (!keep) await this.options.blobs.delete(object)
          }
          await this.store.transaction(async (tx) => {
            await tx.remove(catalogKey(id))
            await tx.removeTree(["storage_object_pages", id])
            await tx.acknowledgeArtifactGarbage([`${id}.pack`])
          })
        } else if (kind === "stream") {
          let cursor: string[] | undefined
          for (;;) {
            const pins = await this.store.snapshot((tx) =>
              tx.query<unknown>({ prefix: ["storage_object_stream_pins", id], after: cursor, limit: 100 }),
            )
            for (const pin of pins) {
              const object = Hash.parse(pin.key.at(-1))
              if (!(await this.store.snapshot((tx) => this.optional(tx, retained(object)))))
                await this.options.blobs.delete(object)
            }
            if (pins.length < 100) break
            cursor = pins.at(-1)!.key
          }
          await this.store.transaction((tx) => this.removeStream(tx, id))
        } else throw new StorageIntegrityError("Unknown artifact collection candidate")
        removed++
        progress?.(removed)
      }
      if (rows.length < 100) break
      after = rows.at(-1)!.key
    }
    await this.store.transaction((tx) => tx.removeTree(["storage_object_collection"]))
    return removed
  }

  private async *hashesOutside(id: string, manifest: z.infer<typeof Manifest>) {
    yield id
    if (manifest.version === 1) {
      for (const chunk of manifest.chunks) yield chunk.hash
      return
    }
    for (let index = 0; index < manifest.pageCount; index++) {
      const page = StoredPage.parse(await this.store.snapshot((tx) => tx.read(pageKey(id, index))))
      yield page.hash
      for (const chunk of page.page.chunks) yield chunk.hash
    }
  }
}
