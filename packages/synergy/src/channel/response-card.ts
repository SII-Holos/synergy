import z from "zod"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { SessionInbox } from "@/session/inbox"
import { SessionManager } from "@/session/manager"
import { MessageV2 } from "@/session/message-v2"
import { loadChannelTaskMessages } from "./outbound-parts"
import {
  ResponseCard,
  ResponseCardCallback,
  ResponseCardIntent,
  type Provider,
  type ResponseCard as ResponseCardType,
  type ResponseCardCallback as ResponseCardCallbackType,
} from "./types"

const log = Log.create({ service: "channel.response-card" })
const RESPONSE_CARD_TTL_MS = 14 * 24 * 60 * 60 * 1_000

function registrationLockKey(key: string[]): string {
  return `channel-response-card:${JSON.stringify(key)}`
}

const PendingRegistration = z
  .object({
    version: z.literal(1),
    status: z.literal("pending"),
    requestId: z.string(),
    channelType: z.string(),
    accountId: z.string(),
    chatId: z.string(),
    requesterId: z.string(),
    sessionID: z.string(),
    replyToMessageId: z.string().optional(),
    card: ResponseCard,
    createdAt: z.number(),
    expiresAt: z.number(),
  })
  .strict()

const ActiveRegistration = PendingRegistration.omit({ status: true }).extend({
  status: z.literal("active"),
  messageId: z.string().min(1),
})

const Registration = z.discriminatedUnion("status", [PendingRegistration, ActiveRegistration])
type Registration = z.infer<typeof Registration>
type ActiveRegistration = z.infer<typeof ActiveRegistration>

export namespace ResponseCardRuntime {
  export async function deliverTaskCards(input: {
    provider: Provider
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    sessionID: string
    terminal: MessageV2.WithParts
    messages?: MessageV2.WithParts[]
  }): Promise<boolean> {
    if (!input.provider.sendResponseCard || input.terminal.info.role !== "assistant") return false

    const rootID = input.terminal.info.rootID ?? input.terminal.info.parentID
    const messages =
      input.messages ??
      (await loadChannelTaskMessages({
        sessionID: input.sessionID,
        rootID,
        terminal: input.terminal,
      }))
    const root = messages.find(
      (message) => message.info.role === "user" && message.info.rootID === rootID && message.info.isRoot === true,
    )
    const requesterId = normalize(root?.info.metadata?.channelRequesterId)
    if (!requesterId) {
      log.warn("response card skipped without requester binding", {
        sessionID: input.sessionID,
        channelType: input.provider.type,
      })
      return false
    }

    const requests = collectRequests(messages, rootID)
    for (const request of requests) {
      await deliverOne({
        ...input,
        requesterId,
        requestId: request.requestId,
        card: request.card,
      })
    }
    return requests.length > 0
  }

  export async function acceptAction(input: {
    channelType: string
    accountId: string
    callback: ResponseCardCallbackType
  }): Promise<{ status: "accepted" | "duplicate" | "expired" | "rejected" }> {
    const parsedCallback = ResponseCardCallback.safeParse(input.callback)
    if (!parsedCallback.success) return { status: "rejected" }
    const callback = parsedCallback.data
    const key = StoragePath.channelResponseCard(input.channelType, input.accountId, callback.requestId)
    using _ = await Lock.write(registrationLockKey(key))

    const stored = await Storage.read<unknown>(key).catch(() => undefined)
    const parsedRegistration = Registration.safeParse(stored)
    if (!parsedRegistration.success) return { status: "rejected" }
    const registration = parsedRegistration.data
    if (registration.expiresAt <= Date.now()) {
      await Storage.remove(key)
      return { status: "expired" }
    }
    if (registration.status !== "active") return { status: "rejected" }
    if (!matchesOwner(registration, input, callback)) return { status: "rejected" }

    const selection = resolveSelection(registration.card, callback)
    if (!selection) return { status: "rejected" }

    const deliveryKey = `response-card:${input.channelType}:${input.accountId}:${callback.eventId}`
    const delivery = await SessionInbox.enqueueMailUnique({
      sessionID: registration.sessionID,
      deliveryKey,
      mail: {
        type: "user",
        parts: [{ type: "text", text: selection.text }] as MessageV2.Part[],
        summary: { title: `Response to ${registration.card.title}` },
        metadata: {
          source: "channel",
          channelPush: true,
          channelReply: true,
          channelReplyToMessageId: registration.messageId,
          channelRequesterId: callback.requesterId,
        },
      },
    })

    if (!delivery.created) return { status: "duplicate" }
    SessionManager.scheduleWake(registration.sessionID, "response-card-action")
    return { status: "accepted" }
  }

  export async function pruneExpired(): Promise<number> {
    const keys = await Storage.list(StoragePath.channelResponseCardsRoot())
    let removed = 0
    for (const key of keys) {
      using _ = await Lock.write(registrationLockKey(key))
      try {
        const stored = await Storage.read<unknown>(key)
        const parsed = Registration.safeParse(stored)
        if (parsed.success && parsed.data.expiresAt > Date.now()) continue
        await Storage.remove(key)
        removed++
      } catch {
        const didRemove = await Storage.remove(key).then(
          () => true,
          () => false,
        )
        if (didRemove) removed++
      }
    }
    return removed
  }

  function collectRequests(messages: MessageV2.WithParts[], rootID: string) {
    const seen = new Set<string>()
    const result: Array<{ requestId: string; card: ResponseCardType }> = []
    for (const message of messages) {
      if (message.info.role !== "assistant" || message.info.rootID !== rootID) continue
      for (const part of message.parts) {
        if (part.type !== "tool" || part.tool !== "response_card" || part.state.status !== "completed") continue
        if (seen.has(part.id)) continue
        const parsed = ResponseCardIntent.safeParse(part.state.metadata.intent)
        if (!parsed.success) continue
        seen.add(part.id)
        result.push({ requestId: part.id, card: parsed.data.card })
      }
    }
    return result
  }

  async function deliverOne(input: {
    provider: Provider
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    sessionID: string
    requesterId: string
    requestId: string
    card: ResponseCardType
  }): Promise<void> {
    const key = StoragePath.channelResponseCard(input.provider.type, input.accountId, input.requestId)
    using _ = await Lock.write(registrationLockKey(key))

    const existing = await Storage.read<unknown>(key).catch(() => undefined)
    const parsedExisting = Registration.safeParse(existing)
    if (parsedExisting.success && parsedExisting.data.expiresAt > Date.now()) return
    if (existing !== undefined) await Storage.remove(key)

    const now = Date.now()
    const pending: Registration = {
      version: 1,
      status: "pending",
      requestId: input.requestId,
      channelType: input.provider.type,
      accountId: input.accountId,
      chatId: input.chatId,
      requesterId: input.requesterId,
      sessionID: input.sessionID,
      replyToMessageId: input.replyToMessageId,
      card: input.card,
      createdAt: now,
      expiresAt: now + RESPONSE_CARD_TTL_MS,
    }
    await Storage.write(key, pending)

    const sent = await input.provider.sendResponseCard!({
      accountId: input.accountId,
      chatId: input.chatId,
      ...(input.chatType ? { chatType: input.chatType } : {}),
      ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
      replyToMessageId: input.replyToMessageId,
      requestId: input.requestId,
      card: input.card,
    })
    if (!sent.messageId.trim()) throw new Error("Response card provider returned no message ID")
    const active: ActiveRegistration = { ...pending, status: "active", messageId: sent.messageId }
    await Storage.write(key, active)
  }

  function matchesOwner(
    registration: ActiveRegistration,
    input: { channelType: string; accountId: string },
    callback: ResponseCardCallbackType,
  ) {
    return (
      registration.channelType === input.channelType &&
      registration.accountId === input.accountId &&
      registration.chatId === callback.chatId &&
      registration.requesterId === callback.requesterId &&
      registration.messageId === callback.messageId
    )
  }

  function resolveSelection(card: ResponseCardType, callback: ResponseCardCallbackType) {
    const id = callback.action.id.slice("response_card:".length)
    const element = card.elements.find((candidate) => candidate.type !== "text" && candidate.id === id)
    if (!element || element.type !== callback.action.type) return undefined

    if (element.type === "button") {
      if (element.value !== callback.action.value) return undefined
      return { text: `Selected "${element.label}" on "${card.title}".` }
    }

    const option = element.options.find((candidate) => candidate.value === callback.action.value)
    if (!option) return undefined
    return { text: `Selected "${option.label}" for "${element.label}" on "${card.title}".` }
  }

  function normalize(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const normalized = value.trim()
    return normalized || undefined
  }
}
