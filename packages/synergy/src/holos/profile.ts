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
    syncToRemote(profile).catch((err) =>
      log.debug("remote profile sync skipped", { error: err instanceof Error ? err.message : String(err) }),
    )
    return profile
  }

  async function syncToRemote(profile: Info): Promise<void> {
    const { HolosReadiness } = await import("./readiness")
    const { HolosRequest } = await import("./request")
    const { HOLOS_URL } = await import("./constants")

    const { readiness } = await HolosReadiness.snapshot()
    if (!readiness.ready) return

    const url = new URL("/api/v1/holos/agent_tunnel/me/profile", HOLOS_URL).toString()
    const response = await HolosRequest.fetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: { name: profile.name, description: profile.bio } }),
      },
      { capability: "profile_sync" },
    )
    if (response.ok) {
      log.info("profile synced to Holos")
    } else {
      log.debug("remote profile sync failed", { status: response.status })
    }
  }
}
