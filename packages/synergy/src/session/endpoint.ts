import z from "zod"
import { Info as ChannelInfo, toKey as channelToKey } from "@/channel/types"

export namespace SessionEndpoint {
  export const Channel = z
    .object({
      kind: z.literal("channel"),
      channel: ChannelInfo,
    })
    .meta({ ref: "SessionChannelEndpoint" })

  export const Holos = z
    .object({
      kind: z.literal("holos"),
      agentId: z.string(),
    })
    .meta({ ref: "SessionHolosEndpoint" })

  export const Info = z.discriminatedUnion("kind", [Channel, Holos]).meta({ ref: "SessionEndpoint" })
  export type Info = z.infer<typeof Info>

  export function fromChannel(channel: ChannelInfo): Info {
    return {
      kind: "channel",
      channel,
    }
  }

  export function holos(agentId: string): Info {
    return {
      kind: "holos",
      agentId,
    }
  }

  export function type(endpoint: Info | undefined): string | undefined {
    if (!endpoint) return undefined
    if (endpoint.kind === "channel") return endpoint.channel.type
    return "holos"
  }

  export function toKey(endpoint: Info): string {
    if (endpoint.kind === "channel") {
      return `channel:${channelToKey(endpoint.channel)}`
    }

    return `holos:${endpoint.agentId}`
  }

  export function isHolos(endpoint: Info | undefined): endpoint is z.infer<typeof Holos> {
    return endpoint?.kind === "holos"
  }
}
