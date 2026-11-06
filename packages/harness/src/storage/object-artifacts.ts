import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { ReclaimableBlobStore } from "./blobs"
import { ArtifactLocation } from "./artifact-location"
import { StorageConflictError, StorageIntegrityError, NotFoundError } from "./errors"
import type { StoreTransaction, TransactionalStore } from "./transactional-store"

const chunkBytes = 4 * 1024 * 1024
const manifestBytes = 4 * 1024 * 1024
const retentionMs = 7 * 86_400_000
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Manifest = z
  .object({
    version: z.literal(1),
    size: z.number().int().nonnegative().safe(),
    sha256: Hash,
    chunks: z.array(z.object({ hash: Hash, size: z.number().int().positive().max(chunkBytes) }).strict()).max(32_768),
  })
  .strict()
  .refine((m) => m.chunks.reduce((sum, c) => sum + c.size, 0) === m.size, "Invalid artifact manifest size")
const Catalog = z
  .object({ manifest: Manifest, unreferencedSince: z.number().optional(), deleting: z.boolean().optional() })
  .strict()
const Intent = z.object({ writerID: z.string().min(1), manifest: Hash }).strict()
type Prepared = { location: ArtifactLocation; intentID: string }

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
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, offset + chunkBytes)
      chunks.push({ hash: hash(chunk), size: chunk.length })
    }
    const manifest = Manifest.parse({ version: 1, size: bytes.length, sha256: hash(bytes), chunks })
    const encoded = new TextEncoder().encode(JSON.stringify(manifest))
    if (encoded.length > manifestBytes) throw new StorageConflictError("Artifact manifest exceeds its byte limit")
    const id = hash(encoded)
    const intentID = randomUUID()
    await this.store.transaction(
      async (tx) => {
        const old = await tx.read<unknown>(catalogKey(id)).catch((error) => {
          if (error instanceof NotFoundError) return undefined
          throw error
        })
        if (old && Catalog.parse(old).deleting) throw new StorageConflictError("Artifact is being reclaimed")
        await tx.write(catalogKey(id), { manifest })
        await tx.write(intentKey(intentID), { writerID: this.options.writerID, manifest: id })
      },
      { operationID: `artifact-prepare:${intentID}`, requestHash: id },
    )
    try {
      let offset = 0
      for (const chunk of chunks) {
        await this.options.blobs.put(chunk.hash, bytes.subarray(offset, offset + chunk.size))
        offset += chunk.size
      }
      await this.options.blobs.put(id, encoded)
    } catch (error) {
      this.released.add(intentID)
      throw error
    }
    return {
      intentID,
      location: ArtifactLocation.parse({
        pack: `${id}.pack`,
        blockOffset: 0,
        blockBytes: bytes.length,
        decodedBytes: bytes.length,
        offset: 0,
        size: bytes.length,
        codec: "raw",
        sha256: manifest.sha256,
      }),
    }
  }

  async publish(tx: StoreTransaction, prepared: Prepared) {
    const intent = Intent.parse(await tx.read(intentKey(prepared.intentID)))
    if (intent.writerID !== this.options.writerID || `${intent.manifest}.pack` !== prepared.location.pack)
      throw new StorageConflictError("Artifact preparation belongs to another writer")
    const catalog = Catalog.parse(await tx.read(catalogKey(intent.manifest)))
    if (catalog.deleting) throw new StorageConflictError("Artifact is being reclaimed")
    await tx.remove(intentKey(prepared.intentID))
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
    return manifest
  }

  async read(location: ArtifactLocation, maximum?: number) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0 || location.size > maximum))
      throw new StorageIntegrityError("Artifact exceeds its byte limit")
    const manifest = await this.manifest(location)
    const output = new Uint8Array(manifest.size)
    let offset = 0
    for (const chunk of manifest.chunks) {
      const bytes = verify(await this.options.blobs.get(chunk.hash, chunk.size), chunk.hash, chunk.size)
      if (bytes.length !== chunk.size) throw new StorageIntegrityError("Artifact chunk size mismatch")
      output.set(bytes, offset)
      offset += bytes.length
    }
    return verify(output, manifest.sha256, manifest.size)
  }

  async verify(location: ArtifactLocation) {
    const manifest = await this.manifest(location)
    const checksum = createHash("sha256")
    for (const chunk of manifest.chunks) {
      const bytes = verify(await this.options.blobs.get(chunk.hash, chunk.size), chunk.hash, chunk.size)
      if (bytes.length !== chunk.size) throw new StorageIntegrityError("Artifact chunk size mismatch")
      checksum.update(bytes)
    }
    if (checksum.digest("hex") !== manifest.sha256) throw new StorageIntegrityError("Artifact checksum mismatch")
  }

  async validate(options: { accept?: (key: string[]) => boolean; progress?: (count: number) => void }) {
    const intents: string[] = []
    const locations = await this.store.transaction(async (tx) => {
      const locations = []
      const pinned = new Set<string>()
      for await (const entry of tx.artifacts()) {
        if (options.accept && !options.accept(entry.key)) continue
        locations.push(entry.location)
        if (pinned.has(entry.location.pack)) continue
        const id = Hash.parse(entry.location.pack.slice(0, -5))
        const catalog = Catalog.parse(await tx.read(catalogKey(id)))
        if (catalog.deleting) throw new StorageIntegrityError("A referenced artifact was marked for deletion")
        const intentID = randomUUID()
        intents.push(intentID)
        await tx.write(intentKey(intentID), { writerID: this.options.writerID, manifest: id })
        pinned.add(entry.location.pack)
      }
      return locations
    })
    try {
      let count = 0
      for (const location of locations) {
        await this.verify(location)
        count++
        if (count % 256 === 0) options.progress?.(count)
      }
      options.progress?.(count)
      return count
    } finally {
      await this.store.transaction(async (tx) => {
        for (const id of intents) await tx.remove(intentKey(id))
      })
    }
  }

  /** The caller must have confirmed physical stop and fenced this exact previous writer. */
  async retireWriter(writerID: string) {
    if (!writerID || writerID === this.options.writerID)
      throw new StorageConflictError("Cannot retire the current artifact writer")
    await this.store.transaction(async (tx) => {
      for (const row of await this.records(tx, "storage_object_intents")) {
        if (Intent.parse(row.value).writerID === writerID) await tx.remove(row.key)
      }
    })
  }

  private async records(tx: StoreTransaction, kind: string) {
    const rows = []
    let after: string[] | undefined
    for (;;) {
      const page = await tx.query<unknown>({ prefix: [kind], after, limit: 256 })
      rows.push(...page)
      if (page.length < 256) return rows
      after = page.at(-1)!.key
    }
  }

  async collect(preparedPacks: Iterable<string>, progress?: (count: number) => void) {
    const released = [...this.released]
    const plan = await this.store.transaction(async (tx) => {
      for (const id of released) await tx.remove(intentKey(id))
      const pinned = new Set<string>(preparedPacks)
      for await (const pack of tx.artifactPacks()) pinned.add(pack)
      for (const key of await tx.list(["storage_pack_pins"])) pinned.add(key[1]!)
      for (const row of await this.records(tx, "storage_object_intents"))
        pinned.add(`${Intent.parse(row.value).manifest}.pack`)
      const rows = (await this.records(tx, "storage_object_manifests")).map((row) => ({
        id: Hash.parse(row.key[1]),
        value: Catalog.parse(row.value),
      }))
      const candidates = []
      const retained = new Set<string>()
      const now = this.now()
      for (const row of rows) {
        if (pinned.has(`${row.id}.pack`)) {
          if (row.value.deleting) throw new StorageIntegrityError("A referenced artifact was marked for deletion")
          if (row.value.unreferencedSince !== undefined)
            await tx.write(catalogKey(row.id), { manifest: row.value.manifest })
          retained.add(row.id)
          for (const chunk of row.value.manifest.chunks) retained.add(chunk.hash)
          continue
        }
        const since = row.value.unreferencedSince ?? now
        if (!row.value.deleting && now - since < retentionMs) {
          await tx.write(catalogKey(row.id), { ...row.value, unreferencedSince: since })
          retained.add(row.id)
          for (const chunk of row.value.manifest.chunks) retained.add(chunk.hash)
          continue
        }
        await tx.write(catalogKey(row.id), { ...row.value, unreferencedSince: since, deleting: true })
        candidates.push(row)
      }
      return { candidates, retained }
    })
    for (const id of released) this.released.delete(id)
    let removed = 0
    for (const row of plan.candidates) {
      const hashes = new Set([row.id, ...row.value.manifest.chunks.map((c) => c.hash)])
      for (const id of hashes) if (!plan.retained.has(id)) await this.options.blobs.delete(id)
      await this.store.transaction(async (tx) => {
        await tx.remove(catalogKey(row.id))
        await tx.acknowledgeArtifactGarbage([`${row.id}.pack`])
      })
      removed++
      progress?.(removed)
    }
    return removed
  }
}
