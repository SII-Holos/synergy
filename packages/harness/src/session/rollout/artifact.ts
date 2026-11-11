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
  type RangePosition = { index: number; offset: number }
  const rangeState = Storage.state(() => ({ positions: new Map<string, RangePosition>(), size: 0 }))
  const rangeCacheBytes = 2 * 1024 * 1024
  const rangeWeight = (identity: string) => Buffer.byteLength(identity) + 64

  function rememberRange(identity: string, position: RangePosition) {
    const cache = rangeState()
    if (cache.positions.delete(identity)) cache.size -= rangeWeight(identity)
    const weight = rangeWeight(identity)
    if (weight > rangeCacheBytes) return
    while (cache.positions.size && cache.size + weight > rangeCacheBytes) {
      const first = cache.positions.keys().next().value!
      cache.positions.delete(first)
      cache.size -= rangeWeight(first)
    }
    cache.positions.set(identity, position)
    cache.size += weight
  }

  export async function readRange(owner: Owner, input: Ref, offset: number, limit: number, signal?: AbortSignal) {
    const ref = Ref.parse(input)
    z.number().int().nonnegative().safe().parse(offset)
    z.number().int().min(1).max(65_540).parse(limit)
    signal?.throwIfAborted()
    if (offset > ref.bytes) throw new RangeError("Content offset exceeds the recorded artifact")
    if ((ref.bytes === 0) !== (ref.chunks === 0)) throw new Error("Rollout artifact integrity check failed")
    const key = artifactRoot(owner, ref.id)
    const result = Buffer.alloc(Math.min(limit, ref.bytes - offset))
    if (!result.length) return result
    const identity = JSON.stringify([Owner.parse(owner), ref.id, ref.chunks, ref.bytes, ref.sha256])
    const previous = rangeState().positions.get(identity)
    let position = previous && previous.offset <= offset ? { ...previous } : { index: 0, offset: 0 }
    const end = offset + result.length
    let written = 0
    let resume = position
    while (position.index < ref.chunks && written < result.length) {
      signal?.throwIfAborted()
      const entries = await Storage.readMany(
        Array.from({ length: Math.min(128, ref.chunks - position.index) }, (_, next) => [
          ...key,
          "chunks",
          String(position.index + next).padStart(12, "0"),
        ]),
      )
      signal?.throwIfAborted()
      for (const entry of entries) {
        signal?.throwIfAborted()
        const chunk = Chunk.parse(entry)
        const start = position.offset
        const next = start + chunk.bytes
        if (next > ref.bytes) throw new Error("Rollout artifact integrity check failed")
        const index = position.index
        position = { index: index + 1, offset: next }
        if (next <= offset) continue
        const data = await Storage.readBinary([...root(owner), "blobs", chunk.sha256], { maxBytes: CHUNK_BYTES })
        signal?.throwIfAborted()
        if (
          data.byteLength !== chunk.bytes ||
          new Bun.CryptoHasher("sha256").update(data).digest("hex") !== chunk.sha256
        )
          throw new Error("Rollout artifact integrity check failed")
        const from = Math.max(0, offset - start)
        const to = Math.min(data.length, end - start)
        result.set(data.subarray(from, to), written)
        written += to - from
        resume = end < next ? { index, offset: start } : position
        if (written === result.length) break
      }
    }
    if (
      written !== result.length ||
      (end === ref.bytes && (position.index !== ref.chunks || position.offset !== ref.bytes))
    )
      throw new Error("Rollout artifact integrity check failed")
    rememberRange(identity, resume)
    return result
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
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 65_536, text.length)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
        yield new TextEncoder().encode(text.slice(offset, end))
        offset = end
      }
    }
    return write(owner, source(), mediaType)
  }

  export type CheckpointCommit = (ref: Ref, publish: () => Promise<void>) => Promise<void>
  export type Writer = {
    id: string
    readonly committed: Ref
    append(bytes: Uint8Array): Promise<void>
    checkpoint(commit?: CheckpointCommit): Promise<Ref>
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

    async function flush(commit?: CheckpointCommit) {
      if (!filled) {
        await commit?.({ ...ref }, async () => {})
        return
      }
      const data = buffer.subarray(0, filled)
      const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex")
      const next = { ...ref, bytes: ref.bytes + filled, chunks: ref.chunks + 1 }
      await record(async () => {
        using prepared = await Storage.prepareBinary([...base, "blobs", sha256], data)
        const publish = async () => {
          await Storage.publishPreparedBinary(prepared)
          await Storage.write([...key, "chunks", String(ref.chunks).padStart(12, "0")], { sha256, bytes: filled })
          await Storage.write([...key, "info"], next)
        }
        if (commit) await commit({ ...next }, publish)
        else await Storage.transaction(publish)
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
      checkpoint(commit) {
        return exclusive(async () => {
          await flush(commit)
          return { ...ref }
        })
      },
      append(bytes) {
        return exclusive(async () => {
          if (finished) throw new Error("Rollout artifact is already closed")
          for (let offset = 0; offset < bytes.byteLength;) {
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

  /** Read one verified immutable chunk so external exporters can resume with bounded memory and work. */
  export async function readChunk(owner: Owner, input: string | Ref, index: number): Promise<Uint8Array> {
    const ref = typeof input === "string" ? await get(owner, input) : Ref.parse(input)
    z.number().int().nonnegative().lt(ref.chunks).parse(index)
    const key = artifactRoot(owner, ref.id)
    const chunk = Chunk.parse(await Storage.read([...key, "chunks", String(index).padStart(12, "0")]))
    const data = await Storage.readBinary([...root(owner), "blobs", chunk.sha256], { maxBytes: CHUNK_BYTES })
    if (data.byteLength !== chunk.bytes || new Bun.CryptoHasher("sha256").update(data).digest("hex") !== chunk.sha256)
      throw new Error("Rollout artifact integrity check failed")
    return data
  }

  export async function* read(owner: Owner, input: string | Ref): AsyncGenerator<Uint8Array> {
    const ref = typeof input === "string" ? await get(owner, input) : Ref.parse(input)
    const hash = new Bun.CryptoHasher("sha256")
    let bytes = 0
    for (let index = 0; index < ref.chunks; index++) {
      const data = await readChunk(owner, ref, index)
      bytes += data.byteLength
      hash.update(data)
      yield data
    }
    if (bytes !== ref.bytes || (ref.status === "complete" && hash.digest("hex") !== ref.sha256)) {
      throw new Error("Rollout artifact integrity check failed")
    }
  }
}
