import z from "zod"
import { Info as ChannelInfo, toKey as channelToKey } from "@/channel/types"

export namespace SessionEndpoint {
  export const Channel = z
    .object({
      kind: z.literal("channel"),
      channel: ChannelInfo,
    })
    .meta({ ref: "SessionChannelEndpoint" })

  export const Info = Channel.meta({ ref: "SessionEndpoint" })
  export type Info = z.infer<typeof Info>

  export function fromChannel(channel: ChannelInfo): Info {
    return {
      kind: "channel",
      channel,
    }
  }

  export function type(endpoint: Info | undefined): string | undefined {
    if (!endpoint) return undefined
    return endpoint.channel.type
  }

  export function toKey(endpoint: Info): string {
    return `channel:${channelToKey(endpoint.channel)}`
  }
}
