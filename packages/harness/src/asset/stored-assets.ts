import { createHash } from "node:crypto"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import type { Asset } from "./asset"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"

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
