import { createHash } from "node:crypto"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import type { Asset } from "./asset"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { Lock } from "../util/lock"

const Info = z
  .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().safe() })
  .strict()
const infoKey = (id: string) => ["asset_manifest", id]
const dataKey = (id: string) => ["assets", id]
const optional = <T>(read: Promise<T>) =>
  read.catch((error) => {
    if (error instanceof Storage.NotFoundError) return undefined
    throw error
  })

/** Asset IDs keep their public shape; the full checksum prevents truncated-ID collisions. */
export function storedAssets(): Asset.Persistence {
  return {
    async open(id, signal) {
      if (!AssetReference.isValidId(id)) return undefined
      const raw = await optional(Storage.read(infoKey(id), { silentNotFound: true }))
      if (raw === undefined) return undefined
      const info = Info.parse(raw)
      if (!info.sha256.startsWith(id.split(".")[0]!))
        throw new StorageIntegrityError("Asset checksum does not match its identifier")
      const location = (await Storage.artifactReferences({ prefix: dataKey(id), limit: 1 }))[0]
      if (
        !location ||
        JSON.stringify(location.key) !== JSON.stringify(dataKey(id)) ||
        location.location.size !== info.bytes ||
        location.location.sha256 !== info.sha256
      )
        throw new StorageIntegrityError("Asset content metadata mismatch")
      signal?.throwIfAborted()
      return { id, ...info, stream: (signal) => Storage.readBinaryStream(dataKey(id), { signal }) }
    },
    async installStream(input) {
      if (!AssetReference.isValidId(input.id) || !input.sha256.startsWith(input.id.split(".")[0]!))
        throw new StorageIntegrityError("Asset checksum does not match its identifier")
      const info = Info.parse({ bytes: input.bytes, sha256: input.sha256 })
      using lease = await Lock.write("stored-asset-content:" + input.id)
      const previous = await optional(Storage.read(infoKey(input.id), { silentNotFound: true }))
      if (previous !== undefined) {
        if (JSON.stringify(Info.parse(previous)) !== JSON.stringify(info))
          throw new StorageIntegrityError("Asset identifier collision")
        return { id: input.id, ...info, created: false }
      }
      const hash = createHash("sha256")
      let bytes = 0
      using prepared = await Storage.prepareBinaryStream(
        dataKey(input.id),
        (async function* () {
          for await (const block of input.content) {
            input.signal?.throwIfAborted()
            hash.update(block)
            bytes += block.length
            if (!Number.isSafeInteger(bytes) || bytes > info.bytes)
              throw new StorageIntegrityError("Asset import byte count mismatch")
            yield block
          }
        })(),
        { signal: input.signal },
      )
      if (bytes !== info.bytes || hash.digest("hex") !== info.sha256)
        throw new StorageIntegrityError("Asset import byte count or checksum mismatch")
      input.signal?.throwIfAborted()
      let created = false
      await Storage.transaction(async (tx) => {
        const latest = await optional(tx.read(infoKey(input.id)))
        if (latest !== undefined) {
          if (JSON.stringify(Info.parse(latest)) !== JSON.stringify(info))
            throw new StorageIntegrityError("Asset identifier collision")
          return
        }
        await Storage.publishPreparedBinary(prepared)
        await tx.write(infoKey(input.id), info)
        created = true
      })
      return { id: input.id, ...info, created }
    },
    async write(id, bytes) {
      if (!AssetReference.isValidId(id)) throw new StorageIntegrityError("Invalid asset identifier")
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (!sha256.startsWith(id.split(".")[0]!))
        throw new StorageIntegrityError("Asset checksum does not match its identifier")
      const previous = await optional(Storage.read(infoKey(id), { silentNotFound: true }))
      if (previous !== undefined) {
        if (Info.parse(previous).sha256 !== sha256) throw new StorageIntegrityError("Asset identifier collision")
        return
      }
      using prepared = await Storage.prepareBinary(dataKey(id), bytes)
      await Storage.transaction(async (tx) => {
        const latest = await optional(tx.read(infoKey(id)))
        if (latest !== undefined) {
          if (Info.parse(latest).sha256 !== sha256) throw new StorageIntegrityError("Asset identifier collision")
          return
        }
        await Storage.publishPreparedBinary(prepared)
        await tx.write(infoKey(id), { sha256, bytes: bytes.length })
      })
    },
    async read(id) {
      if (!AssetReference.isValidId(id)) return undefined
      const value = await optional(Storage.read(infoKey(id), { silentNotFound: true }))
      if (value === undefined) return undefined
      const info = Info.parse(value)
      const bytes = await Storage.readBinary(dataKey(id), { maxBytes: info.bytes })
      if (bytes.length !== info.bytes || createHash("sha256").update(bytes).digest("hex") !== info.sha256)
        throw new StorageIntegrityError("Asset checksum mismatch")
      return bytes
    },
  }
}
