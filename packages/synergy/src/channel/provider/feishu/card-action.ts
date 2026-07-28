import z from "zod"
import type { Config } from "../../../config/config"
import { Log } from "../../../util/log"
import { resolveGroupScopeKey } from "./session-scope"

const log = Log.create({ service: "channel.feishu.card-action" })
const CARD_ACTION_TTL_MS = 14 * 24 * 60 * 60 * 1000
const MAX_CARD_ACTIONS = 5_000
const MAX_EVENT_IDS = 1_000

export const FeishuCardActionName = z.enum(["new", "status", "help"])
export type FeishuCardActionName = z.infer<typeof FeishuCardActionName>

const CallbackPayload = z
  .object({
    header: z
      .object({
        event_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    event: z
      .object({
        operator: z
          .object({
            open_id: z.string().optional(),
          })
          .passthrough()
          .optional(),
        action: z
          .object({
            value: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        context: z
          .object({
            open_message_id: z.string().optional(),
            open_chat_id: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    action: z
      .object({
        value: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    context: z
      .object({
        open_message_id: z.string().optional(),
        open_chat_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    event_id: z.string().optional(),
    operator: z
      .object({
        open_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    value: z.unknown().optional(),
    open_message_id: z.string().optional(),
    open_chat_id: z.string().optional(),
  })
  .passthrough()

type ParsedCardAction =
  | { kind: "unhandled" }
  | { kind: "invalid"; reason: "action" | "identity" | "context" }
  | {
      kind: "action"
      eventId: string
      operatorOpenId: string
      messageId: string
      chatId: string
      action: FeishuCardActionName
    }

function normalize(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result ? result : undefined
}

function extractAction(value: unknown): { present: boolean; value?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { present: false }
  if (!("synergy_builtin_action" in value)) return { present: false }
  return { present: true, value: (value as Record<string, unknown>).synergy_builtin_action }
}

export function parseFeishuCardAction(data: unknown): ParsedCardAction {
  const parsed = CallbackPayload.safeParse(data)
  if (!parsed.success) return { kind: "unhandled" }

  const payload = parsed.data
  const actionValue = extractAction(payload.event?.action?.value ?? payload.action?.value ?? payload.value)
  if (!actionValue.present) return { kind: "unhandled" }

  const action = FeishuCardActionName.safeParse(actionValue.value)
  if (!action.success) return { kind: "invalid", reason: "action" }

  const operatorOpenId = normalize(payload.event?.operator?.open_id ?? payload.operator?.open_id)
  if (!operatorOpenId) return { kind: "invalid", reason: "identity" }

  const eventId = normalize(payload.header?.event_id ?? payload.event_id)
  const messageId = normalize(
    payload.event?.context?.open_message_id ?? payload.context?.open_message_id ?? payload.open_message_id,
  )
  const chatId = normalize(
    payload.event?.context?.open_chat_id ?? payload.context?.open_chat_id ?? payload.open_chat_id,
  )
  if (!eventId || !messageId || !chatId) return { kind: "invalid", reason: "context" }

  return {
    kind: "action",
    eventId,
    operatorOpenId,
    messageId,
    chatId,
    action: action.data,
  }
}

export type FeishuCardActionOwner = {
  accountId: string
  chatId: string
  chatType: "dm" | "group"
  senderId: string
  rootId?: string
  threadId?: string
  groupSessionScope?: Config.FeishuGroupSessionScope
}

export type FeishuCardActionContext = {
  channelType: "feishu"
  accountId: string
  chatId: string
  chatType: "dm" | "group"
  senderId: string
  scopeKey?: string
  messageId: string
  rootId?: string
  threadId?: string
  command: FeishuCardActionName
}

type CardActionResponse = {
  toast: {
    type: "success" | "error" | "warning" | "info"
    content: string
  }
}

type RegisteredCardAction = FeishuCardActionOwner & {
  expiresAt: number
}

export class FeishuCardActionRouter {
  private readonly cards = new Map<string, RegisteredCardAction>()
  private readonly eventIds = new Set<string>()

  register(messageId: string, owner: FeishuCardActionOwner): void {
    this.prune()
    this.cards.set(messageId, { ...owner, expiresAt: Date.now() + CARD_ACTION_TTL_MS })
    while (this.cards.size > MAX_CARD_ACTIONS) {
      const oldest = this.cards.keys().next().value
      if (typeof oldest !== "string") break
      this.cards.delete(oldest)
    }
  }

  handle(
    data: unknown,
    accountId: string,
    dispatch: (context: FeishuCardActionContext) => Promise<void>,
  ): CardActionResponse | undefined {
    const parsed = parseFeishuCardAction(data)
    if (parsed.kind === "unhandled") return undefined
    if (parsed.kind === "invalid") {
      if (parsed.reason === "action") return toast("error", "不支持此操作")
      if (parsed.reason === "identity") return toast("error", "无法验证操作身份")
      return toast("warning", "此操作已失效，请发送新消息")
    }

    this.prune()
    if (this.eventIds.has(parsed.eventId)) return toast("info", "操作已接收")

    const owner = this.cards.get(parsed.messageId)
    if (!owner || owner.accountId !== accountId || owner.chatId !== parsed.chatId) {
      return toast("warning", "此操作已失效，请发送新消息")
    }
    if (owner.chatType === "dm" && owner.senderId !== parsed.operatorOpenId) {
      return toast("error", "无法验证操作身份")
    }

    this.eventIds.add(parsed.eventId)
    while (this.eventIds.size > MAX_EVENT_IDS) {
      const oldest = this.eventIds.values().next().value
      if (typeof oldest !== "string") break
      this.eventIds.delete(oldest)
    }

    const scopeKey =
      owner.chatType === "group"
        ? resolveGroupScopeKey({
            chatId: owner.chatId,
            senderId: parsed.operatorOpenId,
            rootId: owner.rootId,
            threadId: owner.threadId,
            scope: owner.groupSessionScope ?? "group",
          })
        : undefined

    setTimeout(() => {
      void dispatch({
        channelType: "feishu",
        accountId,
        chatId: owner.chatId,
        chatType: owner.chatType,
        senderId: parsed.operatorOpenId,
        scopeKey,
        messageId: parsed.messageId,
        rootId: owner.rootId,
        threadId: owner.threadId,
        command: parsed.action,
      }).catch((error) => {
        log.error("failed to execute card action", {
          accountId,
          messageId: parsed.messageId,
          action: parsed.action,
          error,
        })
      })
    })

    return toast("success", "操作已接收")
  }

  private prune(): void {
    const now = Date.now()
    for (const [messageId, owner] of this.cards) {
      if (owner.expiresAt <= now) this.cards.delete(messageId)
    }
  }
}

function toast(type: CardActionResponse["toast"]["type"], content: string): CardActionResponse {
  return { toast: { type, content } }
}
