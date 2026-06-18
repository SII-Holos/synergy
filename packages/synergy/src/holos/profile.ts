import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.profile" })

export namespace HolosProfile {
  export const Info = z
    .object({
      name: z.string(),
      bio: z.string(),
      initialized: z.boolean(),
      initializedAt: z.number().optional(),
    })
    .meta({ ref: "HolosProfile" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("holos.profile.updated", z.object({ profile: Info })),
  }

  export function defaultProfile(): Info {
    return {
      name: "Synergy",
      bio: "A general-purpose AI companion, ready to help with coding, writing, research, and anything else.",
      initialized: true,
      initializedAt: Date.now(),
    }
  }

  export async function get(): Promise<Info | undefined> {
    try {
      return await Storage.read<Info>(StoragePath.holosProfile())
    } catch {
      return undefined
    }
  }

  export async function update(profile: Info): Promise<Info> {
    await Storage.write(StoragePath.holosProfile(), profile)
    await Bus.publish(Event.Updated, { profile })
    log.info("profile updated", { name: profile.name })
    return profile
  }
}
