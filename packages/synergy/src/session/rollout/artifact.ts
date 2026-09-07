import z from "zod"
import { RolloutSchema } from "./schema"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
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
  const options = { private: true, durable: true, compact: true } as const

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
    const ids = await Storage.scan([...root(owner), "artifacts"], { strict: true })
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
    await record(() => Storage.write([...key, "info"], ref, options))
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
        await Storage.write(
          [...key, "chunks", String(ref.chunks).padStart(12, "0")],
          { sha256, bytes: filled },
          options,
        )
        await Storage.write([...key, "info"], next, options)
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
          await record(() => Storage.write([...key, "info"], final, options))
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
