import z from "zod"
import { Info as ChannelInfo, toKey as channelToKey } from "@/channel/types"

export namespace SessionEndpoint {
  export const Channel = z
    .object({
      kind: z.literal("channel"),
      channel: ChannelInfo,
    })
    .meta({ ref: "SessionChannelEndpoint" })

  export const Clarus = z
    .object({
      kind: z.literal("clarus"),
      role: z.enum(["project", "task"]),
      agentId: z.string(),
      projectId: z.string(),
      taskId: z.string().optional(),
    })
    .meta({ ref: "SessionClarusEndpoint" })

  export const Info = z.discriminatedUnion("kind", [Channel, Clarus]).meta({ ref: "SessionEndpoint" })
  export type Info = z.infer<typeof Info>

  export function fromChannel(channel: ChannelInfo): Info {
    return {
      kind: "channel",
      channel,
    }
  }

  export function fromClarus(input: {
    role: "project" | "task"
    agentId: string
    projectId: string
    taskId?: string
  }): Info {
    return {
      kind: "clarus",
      role: input.role,
      agentId: input.agentId,
      projectId: input.projectId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    }
  }

  export function type(endpoint: Info | undefined): string | undefined {
    if (!endpoint) return undefined
    if (endpoint.kind === "clarus") return "clarus"
    return endpoint.channel.type
  }

  export function toKey(endpoint: Info): string {
    if (endpoint.kind === "clarus") {
      const a = encodeURIComponent(endpoint.agentId)
      const p = encodeURIComponent(endpoint.projectId)
      const base = `clarus:${a}:${p}`
      return endpoint.taskId !== undefined ? `${base}:${encodeURIComponent(endpoint.taskId)}` : base
    }
    return `channel:${channelToKey(endpoint.channel)}`
  }
}
