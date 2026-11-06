import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { Installation } from "../global/installation"
import { RuntimeComponents } from "../lifecycle/components"

export namespace HostIdentity {
  export const Info = z.object({
    id: z.string().uuid(),
    version: z.string(),
    platform: z.string(),
    components: z.array(RuntimeComponents.Info),
  })

  export async function describe() {
    return Storage.transaction(async () => {
      const key = ["session_transfer_host", "identity"]
      const previous = await Storage.read(key).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      const identity = z
        .object({ version: z.literal(1), id: z.string().uuid() })
        .strict()
        .parse(previous ?? { version: 1, id: randomUUID() })
      if (!previous) await Storage.write(key, identity)
      return Info.parse({
        id: identity.id,
        version: Installation.VERSION,
        platform: process.platform,
        components: RuntimeComponents.selected(),
      })
    })
  }
}
