import z from "zod"

export const Info = z
  .object({
    type: z.string(),
    accountId: z.string().optional(),
    chatId: z.string(),
    chatType: z.enum(["dm", "group"]).optional(),
    chatName: z.string().optional(),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    scopeKey: z.string().optional(),
    createdAt: z.number().optional(),
  })
  .meta({
    ref: "ChannelInfo",
  })
export type Info = z.infer<typeof Info>

export function toKey(input: Pick<Info, "type" | "accountId" | "chatId" | "scopeKey">) {
  const base = input.accountId ? `${input.type}:${input.accountId}` : input.type
  if (input.scopeKey) {
    return `${base}:scope:${input.scopeKey}`
  }
  return `${base}:chat:${input.chatId}`
}

export const Status = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("connected") }),
    z.object({ status: z.literal("connecting") }),
    z.object({ status: z.literal("disconnected") }),
    z.object({ status: z.literal("disabled") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ])
  .meta({ ref: "ChannelStatus" })
export type Status = z.infer<typeof Status>

export const Mention = z.object({
  key: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
})
export type Mention = z.infer<typeof Mention>

export const Attachment = z.object({
  path: z.string(),
  contentType: z.string(),
  filename: z.string().optional(),
  placeholder: z.string().optional(),
})
export type Attachment = z.infer<typeof Attachment>

export const OutboundPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    path: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
  }),
  z.object({
    type: z.literal("audio"),
    path: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
  }),
  z.object({
    type: z.literal("video"),
    path: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
    durationMs: z.number().int().positive().optional(),
  }),
])
export type OutboundPart = z.infer<typeof OutboundPart>

export const MessageContext = z
  .object({
    channelType: z.string(),
    accountId: z.string(),
    chatId: z.string(),
    chatType: z.enum(["dm", "group"]),
    senderId: z.string(),
    senderName: z.string().optional(),
    text: z.string(),
    messageId: z.string(),
    timestamp: z.number(),
    wasMentioned: z.boolean().optional(),
    messageType: z.string().optional(),
    rootId: z.string().optional(),
    parentId: z.string().optional(),
    threadId: z.string().optional(),
    mentions: z.array(Mention).optional(),
    quotedContent: z.string().optional(),
    attachments: z.array(Attachment).optional(),
    scopeKey: z.string().optional(),
  })
  .meta({ ref: "ChannelMessageContext" })
export type MessageContext = z.infer<typeof MessageContext>

export type MessageHandler = (ctx: MessageContext) => Promise<void>

export type SendResult = {
  messageId: string
}

export type StreamingToolProgress = {
  id: string
  tool: string
  title?: string
  status: "pending" | "running" | "completed" | "error"
}

export interface StreamingSession {
  start(): Promise<void>
  update(text: string): Promise<void>
  updateToolProgress(progress: StreamingToolProgress[]): Promise<void>
  close(finalText?: string): Promise<void>
  isActive(): boolean
}

export interface Provider<TAccountConfig = unknown, TChannelConfig = unknown> {
  readonly type: string

  connect(input: {
    accountId: string
    accountConfig: TAccountConfig
    channelConfig: TChannelConfig
    onMessage: MessageHandler
    signal: AbortSignal
    onDisconnect?: (reason?: string) => void
  }): Promise<void>

  replyMessage(input: { accountId: string; messageId: string; parts: OutboundPart[] }): Promise<SendResult>

  pushMessage(input: { accountId: string; chatId: string; parts: OutboundPart[] }): Promise<SendResult>

  addReaction(input: { accountId: string; messageId: string; emoji: string }): Promise<{ reactionId: string } | void>

  removeReaction?(input: { accountId: string; messageId: string; reactionId: string }): Promise<void>

  createStreamingSession(input: { accountId: string; chatId: string; replyToMessageId?: string }): StreamingSession
}
