import z from "zod"
import { RolloutSchema } from "./schema"
import { Identifier } from "../../id/id"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { record, RolloutRecordingError } from "./error"

export namespace RolloutArtifact {
  export const CHUNK_BYTES = 1024 * 1024
  export const Owner = RolloutSchema.Owner
  export type Owner = RolloutSchema.Owner
  export const Ref = RolloutSchema.ArtifactRef
  export type Ref = RolloutSchema.ArtifactRef
  const Chunk = z
    .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(CHUNK_BYTES) })
    .strict()
  const rangeState = Storage.state(() => ({
    manifests: new Map<string, Array<z.infer<typeof Chunk> & { offset: number }>>(),
    size: 0,
  }))

  async function manifest(owner: Owner, ref: Ref) {
    const cache = rangeState()
    const identity = JSON.stringify([owner, ref.id, ref.chunks, ref.bytes, ref.sha256])
    const previous = cache.manifests.get(identity)
    if (previous) {
      cache.manifests.delete(identity)
      cache.manifests.set(identity, previous)
      return previous
    }
    const key = artifactRoot(owner, ref.id)
    const result: Array<z.infer<typeof Chunk> & { offset: number }> = []
    let offset = 0
    for (let index = 0; index < ref.chunks; index += 256) {
      const entries = await Storage.readMany(
        Array.from({ length: Math.min(256, ref.chunks - index) }, (_, next) => [
          ...key,
          "chunks",
          String(index + next).padStart(12, "0"),
        ]),
      )
      for (const entry of entries) {
        const chunk = Chunk.parse(entry)
        result.push({ ...chunk, offset })
        offset += chunk.bytes
      }
    }
    if (offset !== ref.bytes) throw new Error("Rollout artifact integrity check failed")
    const size = result.length * 96
    if (size <= 2 * 1024 * 1024 && !cache.manifests.has(identity)) {
      while (cache.manifests.size && cache.size + size > 2 * 1024 * 1024) {
        const first = cache.manifests.keys().next().value!
        cache.size -= cache.manifests.get(first)!.length * 96
        cache.manifests.delete(first)
      }
      cache.manifests.set(identity, result)
      cache.size += size
    }
    return result
  }

  export async function readRange(owner: Owner, input: Ref, offset: number, limit: number) {
    const ref = Ref.parse(input)
    z.number().int().nonnegative().safe().parse(offset)
    z.number().int().min(1).max(65_540).parse(limit)
    if (offset > ref.bytes) throw new RangeError("Content offset exceeds the recorded artifact")
    const chunks = await manifest(owner, ref)
    let left = 0
    let right = chunks.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (chunks[middle].offset + chunks[middle].bytes <= offset) left = middle + 1
      else right = middle
    }
    const parts: Uint8Array[] = []
    const end = Math.min(ref.bytes, offset + limit)
    for (let index = left; index < chunks.length && chunks[index].offset < end; index++) {
      const chunk = chunks[index]
      const data = await Storage.readBinary([...root(owner), "blobs", chunk.sha256], { maxBytes: CHUNK_BYTES })
      if (data.byteLength !== chunk.bytes || new Bun.CryptoHasher("sha256").update(data).digest("hex") !== chunk.sha256)
        throw new Error("Rollout artifact integrity check failed")
      parts.push(data.subarray(Math.max(0, offset - chunk.offset), Math.min(data.length, end - chunk.offset)))
    }
    return Buffer.concat(parts)
  }

  export function root(input: Owner) {
    const owner = Owner.parse(input)
    const scopeID = Identifier.asScopeID(owner.scopeID)
    return owner.kind === "session"
      ? StoragePath.sessionRolloutRoot(scopeID, Identifier.asSessionID(owner.sessionID))
      : StoragePath.operationRolloutRoot(scopeID, owner.operationID)
  }

  function artifactRoot(owner: Owner, id: string) {
    return [...root(owner), "artifacts", z.uuid().parse(id)]
  }

  export async function get(owner: Owner, id: string): Promise<Ref> {
    return Ref.parse(await Storage.read([...artifactRoot(owner, id), "info"]))
  }

  export async function list(owner: Owner): Promise<Ref[]> {
    const ids = await Storage.scan([...root(owner), "artifacts"])
    const result: Ref[] = []
    for (const id of ids) result.push(await get(owner, id))
    return result
  }

  export function writeText(owner: Owner, text: string, mediaType = "text/plain;charset=utf-8") {
    async function* source() {
      for (let offset = 0; offset < text.length; ) {
        let end = Math.min(offset + 65_536, text.length)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
        yield new TextEncoder().encode(text.slice(offset, end))
        offset = end
      }
    }
    return write(owner, source(), mediaType)
  }

  export type Writer = {
    id: string
    readonly committed: Ref
    append(bytes: Uint8Array): Promise<void>
    checkpoint(): Promise<Ref>
    finish(status?: "complete" | "partial"): Promise<Ref>
  }

  export async function write(owner: Owner, source: AsyncIterable<Uint8Array>, mediaType: string): Promise<Ref> {
    const writer = await open(owner, mediaType)
    try {
      for await (const bytes of source) await writer.append(bytes)
      return await writer.finish()
    } catch (error) {
      if (!RolloutRecordingError.isInstance(error)) await writer.finish("partial")
      throw error
    }
  }

  export async function copy(source: Owner, target: Owner, ref: Ref) {
    const writer = await open(target, ref.mediaType)
    for await (const chunk of read(source, ref)) await writer.append(chunk)
    return writer.finish(ref.status)
  }

  export async function open(owner: Owner, mediaType: string): Promise<Writer> {
    const base = root(owner)
    let ref: Ref = {
      version: 1,
      id: crypto.randomUUID(),
      mediaType,
      bytes: 0,
      chunks: 0,
      sha256: null,
      status: "partial",
    }
    const key = artifactRoot(owner, ref.id)
    await record(() => Storage.write([...key, "info"], ref))
    const buffer = new Uint8Array(CHUNK_BYTES)
    const hash = new Bun.CryptoHasher("sha256")
    let filled = 0

    async function flush() {
      if (!filled) return
      const data = buffer.subarray(0, filled)
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex")
      const next = { ...ref, bytes: ref.bytes + filled, chunks: ref.chunks + 1 }
      await record(async () => {
        await Storage.writeBinary([...base, "blobs", sha256], data)
        await Storage.transaction(async () => {
          await Storage.write([...key, "chunks", String(ref.chunks).padStart(12, "0")], { sha256, bytes: filled })
          await Storage.write([...key, "info"], next)
        })
      })
      hash.update(data)
      ref = next
      filled = 0
    }

    let busy = false
    let finished = false
    let failure: unknown
    async function exclusive<T>(action: () => Promise<T>) {
      if (failure) throw failure
      if (busy) throw new Error("Concurrent rollout artifact writes are not supported")
      busy = true
      try {
        return await action()
      } catch (error) {
        failure = error
        throw error
      } finally {
        busy = false
      }
    }
    return {
      id: ref.id,
      get committed() {
        return { ...ref }
      },
      checkpoint() {
        return exclusive(async () => {
          await flush()
          return { ...ref }
        })
      },
      append(bytes) {
        return exclusive(async () => {
          if (finished) throw new Error("Rollout artifact is already closed")
          for (let offset = 0; offset < bytes.byteLength; ) {
            const count = Math.min(CHUNK_BYTES - filled, bytes.byteLength - offset)
            buffer.set(bytes.subarray(offset, offset + count), filled)
            filled += count
            offset += count
            if (filled === CHUNK_BYTES) await flush()
          }
        })
      },
      finish(status = "complete") {
        return exclusive(async () => {
          if (finished) return ref
          await flush()
          const final: Ref = { ...ref, sha256: status === "complete" ? hash.digest("hex") : null, status }
          await record(() => Storage.write([...key, "info"], final))
          ref = final
          finished = true
          return ref
        })
      },
    }
  }

  export async function* read(owner: Owner, input: string | Ref): AsyncGenerator<Uint8Array> {
    const ref = typeof input === "string" ? await get(owner, input) : Ref.parse(input)
    const key = artifactRoot(owner, ref.id)
    const hash = new Bun.CryptoHasher("sha256")
    let bytes = 0
    for (let index = 0; index < ref.chunks; index++) {
      const chunk = Chunk.parse(await Storage.read([...key, "chunks", String(index).padStart(12, "0")]))
      const data = await Storage.readBinary([...root(owner), "blobs", chunk.sha256], { maxBytes: CHUNK_BYTES })
      if (
        data.byteLength !== chunk.bytes ||
        new Bun.CryptoHasher("sha256").update(data).digest("hex") !== chunk.sha256
      ) {
        throw new Error("Rollout artifact integrity check failed")
      }
      bytes += data.byteLength
      hash.update(data)
      yield data
    }
    if (bytes !== ref.bytes || (ref.status === "complete" && hash.digest("hex") !== ref.sha256)) {
      throw new Error("Rollout artifact integrity check failed")
    }
  }
}
