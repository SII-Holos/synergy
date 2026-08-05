import z from "zod"
import type { ChannelHost } from "./host"
import type { Question } from "@/question"
import type { Scope } from "@/scope"

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

export const Status = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("connected") }),
    z.object({ status: z.literal("connecting") }),
    z.object({ status: z.literal("waiting_for_transport") }),
    z.object({ status: z.literal("disconnected") }),
    z.object({ status: z.literal("disabled") }),
    z.object({ status: z.literal("syncing") }),
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
const ResponseCardIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Use a stable identifier without spaces")

const ResponseCardText = z
  .object({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(3_000),
    format: z.enum(["plain", "markdown"]).optional(),
  })
  .strict()

const ResponseCardButton = z
  .object({
    type: z.literal("button"),
    id: ResponseCardIdentifier,
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(100),
    style: z.enum(["default", "primary", "danger"]).optional(),
  })
  .strict()

const ResponseCardSelectOption = z
  .object({
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(100),
  })
  .strict()

const ResponseCardSelect = z
  .object({
    type: z.literal("select"),
    id: ResponseCardIdentifier,
    label: z.string().trim().min(1).max(40),
    placeholder: z.string().trim().min(1).max(60).optional(),
    options: z.array(ResponseCardSelectOption).min(1).max(10),
  })
  .strict()

export const ResponseCardElement = z.discriminatedUnion("type", [
  ResponseCardText,
  ResponseCardButton,
  ResponseCardSelect,
])
export type ResponseCardElement = z.infer<typeof ResponseCardElement>

export const ResponseCard = z
  .object({
    title: z.string().trim().min(1).max(80),
    elements: z.array(ResponseCardElement).min(1).max(20),
  })
  .strict()
  .superRefine((card, ctx) => {
    const elementIDs = new Set<string>()
    for (const [elementIndex, element] of card.elements.entries()) {
      if (element.type === "text") continue
      if (elementIDs.has(element.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["elements", elementIndex, "id"],
          message: "Interactive element IDs must be unique",
        })
      }
      elementIDs.add(element.id)

      if (element.type !== "select") continue
      const optionValues = new Set<string>()
      for (const [optionIndex, option] of element.options.entries()) {
        if (optionValues.has(option.value)) {
          ctx.addIssue({
            code: "custom",
            path: ["elements", elementIndex, "options", optionIndex, "value"],
            message: "Select option values must be unique",
          })
        }
        optionValues.add(option.value)
      }
    }
  })
  .meta({ ref: "ChannelResponseCard" })
export type ResponseCard = z.infer<typeof ResponseCard>

export const ResponseCardIntent = z
  .object({
    type: z.literal("response_card"),
    card: ResponseCard,
  })
  .strict()
  .meta({ ref: "ChannelResponseCardIntent" })
export type ResponseCardIntent = z.infer<typeof ResponseCardIntent>

export const ResponseCardCallback = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    requestId: z.string().trim().min(1).max(200),
    messageId: z.string().trim().min(1).max(200),
    chatId: z.string().trim().min(1).max(200),
    requesterId: z.string().trim().min(1).max(200),
    action: z
      .object({
        type: z.enum(["button", "select"]),
        id: z.string().startsWith("response_card:").max(114),
        value: z.string().trim().min(1).max(100),
      })
      .strict(),
  })
  .strict()
  .meta({ ref: "ChannelResponseCardCallback" })
export type ResponseCardCallback = z.infer<typeof ResponseCardCallback>

export type ResponseCardActionResult = {
  status: "accepted" | "duplicate" | "expired" | "rejected"
}

export const QuestionCardCallbackFormValue = z
  .object({
    name: z
      .string()
      .regex(/^question_\d+$/)
      .max(32),
    selected: z.array(z.string().regex(/^\d+$/).max(10)).max(100),
    custom: z.string().trim().max(1_000).optional(),
  })
  .strict()
export type QuestionCardCallbackFormValue = z.infer<typeof QuestionCardCallbackFormValue>

export const QuestionCardCallback = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    requestId: z.string().trim().min(1).max(200),
    messageId: z.string().trim().min(1).max(200),
    chatId: z.string().trim().min(1).max(200),
    requesterId: z.string().trim().min(1).max(200),
    formValues: z.array(QuestionCardCallbackFormValue).max(100),
  })
  .strict()
  .meta({ ref: "ChannelQuestionCardCallback" })
export type QuestionCardCallback = z.infer<typeof QuestionCardCallback>

export type QuestionCardActionResult = ResponseCardActionResult

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
    chatName: z.string().optional(),
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
    replyToMessageId: z.string().optional(),
    mentions: z.array(Mention).optional(),
    quotedContent: z.string().optional(),
    attachments: z.array(Attachment).optional(),
    scopeKey: z.string().optional(),
  })
  .meta({ ref: "ChannelMessageContext" })
export type MessageContext = z.infer<typeof MessageContext>

export type SendResult = {
  messageId: string
  threadId?: string
}

export type StreamingToolProgress = {
  id: string
  tool: string
  title?: string
  status: "pending" | "generating" | "running" | "completed" | "error"
}

export interface StreamingSession {
  start(): Promise<void>
  update(text: string): Promise<void>
  updateToolProgress(progress: StreamingToolProgress[]): Promise<void>
  close(finalText?: string, error?: boolean): Promise<void>
  isActive(): boolean
}

export type ProviderLifecycle = "self_connected" | "borrowed_transport"

export interface ConversationCapabilities {
  replyMessage?(input: {
    accountId: string
    messageId: string
    chatId?: string
    chatType?: "dm" | "group"
    parts: OutboundPart[]
    scopeKey?: string
  }): Promise<SendResult>

  pushMessage?(input: { accountId: string; chatId: string; parts: OutboundPart[] }): Promise<SendResult>

  addReaction?(input: { accountId: string; messageId: string; emoji: string }): Promise<{ reactionId: string } | void>

  removeReaction?(input: { accountId: string; messageId: string; reactionId: string }): Promise<void>

  createStreamingSession?(input: {
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    replyToMessageId?: string
    sessionID: string
    scopeKey?: string
  }): StreamingSession
}

export interface Provider<TAccountConfig = unknown, TChannelConfig = unknown> {
  readonly type: string
  readonly lifecycle: ProviderLifecycle
  readonly conversation?: ConversationCapabilities
  /**
   * Default agent used for sessions created from this provider's inbound
   * messages. When set, the channel core passes it as the agent override
   * (an account-level `agent` config still wins). When unset, the default
   * agent resolution applies.
   */
  readonly defaultAgent?: string

  waitForTransport?(input: { accountId: string; signal: AbortSignal }): Promise<void>

  /**
   * Resolve the Scope that owns the Session for an inbound conversation
   * message. Providers may return a per-chat Scope (e.g. a managed checkout
   * directory for a GitHub issue thread) instead of the account-level Scope
   * chosen by `resolveAccountScope`. Returning `undefined` keeps the account
   * Scope.
   */
  resolveConversationScope?(input: {
    accountId: string
    accountConfig: TAccountConfig
    message: MessageContext
  }): Promise<Scope | undefined>

  connect(input: {
    accountId: string
    accountConfig: TAccountConfig
    channelConfig: TChannelConfig
    signal: AbortSignal
    host: ChannelHost.Instance
    onDisconnect?: (reason?: string) => void
    onResponseCardAction?: (callback: ResponseCardCallback) => Promise<ResponseCardActionResult>
    onQuestionCardAction?: (callback: QuestionCardCallback) => Promise<QuestionCardActionResult>
  }): Promise<void>
  disconnect?(input: { accountId: string }): Promise<void>

  refreshProjects?(input: { accountId: string; signal: AbortSignal; host: ChannelHost.Instance }): Promise<void>

  replyMessage?(input: {
    accountId: string
    messageId: string
    chatId?: string
    chatType?: "dm" | "group"
    parts: OutboundPart[]
    scopeKey?: string
  }): Promise<SendResult>

  pushMessage?(input: { accountId: string; chatId: string; parts: OutboundPart[] }): Promise<SendResult>

  sendResponseCard?(input: {
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    requestId: string
    card: ResponseCard
  }): Promise<SendResult>

  sendQuestionCard?(input: {
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    requestId: string
    questions: Question.Info[]
  }): Promise<SendResult>

  addReaction?(input: { accountId: string; messageId: string; emoji: string }): Promise<{ reactionId: string } | void>

  removeReaction?(input: { accountId: string; messageId: string; reactionId: string }): Promise<void>

  createStreamingSession?(input: {
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    replyToMessageId?: string
    sessionID: string
    scopeKey?: string
  }): StreamingSession
}
