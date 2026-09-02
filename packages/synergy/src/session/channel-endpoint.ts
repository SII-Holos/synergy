import z from "zod"

/**
 * S9c relocation: the channel endpoint's persisted data contract (target
 * discriminator, channel info with exactly-one-identity validation, key
 * derivation) lives in L1 next to its persistence owner (SessionEndpoint /
 * SessionNavEntry); the channel product domain re-exports it from ./types so
 * both sides parse the same shape. Definitions are byte-identical to the
 * former channel/types.ts owner.
 */
export const ChannelTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), chatId: z.string() }),
  z.object({ kind: z.literal("project"), externalProjectId: z.string() }),
  z.object({ kind: z.literal("task"), externalProjectId: z.string(), externalTaskId: z.string() }),
])
export type ChannelTarget = z.infer<typeof ChannelTarget>

export const Info = z
  .object({
    type: z.string(),
    accountId: z.string().optional(),
    chatId: z.string().optional(),
    target: ChannelTarget.optional(),
    chatType: z.enum(["dm", "group"]).optional(),
    chatName: z.string().optional(),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    scopeKey: z.string().optional(),
    createdAt: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    const hasLegacyIdentity = value.chatId !== undefined || value.scopeKey !== undefined
    if (hasLegacyIdentity === (value.target !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Channel info must define exactly one legacy chat identity or target",
      })
    }
  })
  .meta({
    ref: "ChannelInfo",
  })
export type Info = z.infer<typeof Info>

export function toKey(input: Pick<Info, "type" | "accountId" | "chatId" | "scopeKey"> & { target?: ChannelTarget }) {
  const base = input.accountId ? `${input.type}:${input.accountId}` : input.type
  if (input.target) {
    switch (input.target.kind) {
      case "chat":
        return `${base}:chat:${input.target.chatId}`
      case "project":
        return `${base}:project:${input.target.externalProjectId}`
      case "task":
        return `${base}:project:${input.target.externalProjectId}:task:${input.target.externalTaskId}`
    }
  }
  if (input.scopeKey) {
    return `${base}:scope:${input.scopeKey}`
  }
  return `${base}:chat:${input.chatId}`
}
