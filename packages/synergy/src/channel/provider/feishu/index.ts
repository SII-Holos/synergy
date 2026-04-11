import os from "os"
import path from "path"
import * as Lark from "@larksuiteoapi/node-sdk"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import * as ChannelTypes from "../../types"
import { FeishuStreamingCard } from "./streaming-card"
import { feishuDedup } from "./dedup"
import { senderNameCache } from "./sender"
import { InboundDebouncer } from "./debounce"
import {
  parseMessageContent,
  normalizeMentions,
  fetchQuotedContent,
  downloadMessageMedia,
  extractPostImageKeys,
  downloadImageByKey,
} from "./message"
import type { FeishuEventPayload, FeishuMention, FeishuSender } from "./feishu-types"
import type { FeishuApiContext } from "./api-context"
import { FeishuOutboundMedia } from "./outbound-media"

const log = Log.create({ service: "channel.feishu" })

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
const LARK_API_BASE = "https://open.larksuite.com/open-apis"
const TEXT_MESSAGE_TYPES = new Set(["text", "post"])
const MEDIA_MESSAGE_TYPES = new Set(["image", "file", "audio", "video", "sticker"])
const SELF_SENDER_TYPES = new Set(["app", "bot", "app_bot"])

type AccountState = {
  config: Config.ChannelFeishuAccount
  channelConfig: Config.ChannelFeishu
  apiBase: string
  tokenCache: { token: string; expiresAt: number } | null
  botOpenId?: string
  missingBotOpenIdWarned?: boolean
}

function resolveGroupScopeKey(input: {
  chatId: string
  senderId: string
  rootId?: string
  threadId?: string
  scope: Config.FeishuGroupSessionScope
}): string {
  const { chatId, senderId, rootId, threadId, scope } = input
  const topicId = rootId ?? threadId

  switch (scope) {
    case "group_sender":
      return `${chatId}:sender:${senderId}`
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId
    case "group_topic_sender":
      return topicId ? `${chatId}:topic:${topicId}:sender:${senderId}` : `${chatId}:sender:${senderId}`
    case "group":
    default:
      return chatId
  }
}

function isSelfSender(senderType?: string): boolean {
  if (!senderType) return false
  return SELF_SENDER_TYPES.has(senderType.toLowerCase())
}

function normalizeBotOpenId(openId?: string): string | undefined {
  const normalized = openId?.trim()
  return normalized ? normalized : undefined
}

function resolveSenderOpenId(sender?: FeishuSender): string | undefined {
  return normalizeBotOpenId(sender?.sender_id?.open_id)
}

function isBotMentioned(mentions: FeishuMention[], botOpenId?: string): boolean {
  if (!botOpenId) return false
  return mentions.some((mention) => normalizeBotOpenId(mention.id.open_id) === botOpenId)
}

export class FeishuProvider implements ChannelTypes.Provider<Config.ChannelFeishuAccount, Config.ChannelFeishu> {
  readonly type = "feishu"

  private accounts = new Map<string, AccountState>()

  private static cardActionHandlers: Array<(data: unknown, accountId: string) => Promise<unknown>> = []

  static onCardAction(handler: (data: unknown, accountId: string) => Promise<unknown>): () => void {
    FeishuProvider.cardActionHandlers.push(handler)
    return () => {
      FeishuProvider.cardActionHandlers = FeishuProvider.cardActionHandlers.filter((h) => h !== handler)
    }
  }

  private async getAccessToken(accountId: string): Promise<string> {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Feishu account not found: ${accountId}`)

    if (account.tokenCache && account.tokenCache.expiresAt > Date.now() + 60_000) {
      return account.tokenCache.token
    }

    const response = await fetch(`${account.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: account.config.appId,
        app_secret: account.config.appSecret,
      }),
    })

    const result = (await response.json()) as {
      tenant_access_token: string
      expire: number
    }

    account.tokenCache = {
      token: result.tenant_access_token,
      expiresAt: Date.now() + result.expire * 1000,
    }

    return result.tenant_access_token
  }

  private async ensureBotOpenId(accountId: string): Promise<string | undefined> {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Feishu account not found: ${accountId}`)
    if (account.botOpenId) return account.botOpenId

    try {
      const token = await this.getAccessToken(accountId)
      const response = await fetch(`${account.apiBase}/bot/v3/info`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
      const result = (await response.json()) as {
        code?: number
        msg?: string
        bot?: { open_id?: string }
      }
      const botOpenId = normalizeBotOpenId(result.bot?.open_id)
      if (result.code === 0 && botOpenId) {
        account.botOpenId = botOpenId
        account.missingBotOpenIdWarned = false
        log.info("resolved feishu bot open_id from bot info", { accountId, botOpenId })
        return botOpenId
      }
      log.warn("failed to resolve feishu bot open_id from bot info", {
        accountId,
        code: result.code,
        msg: result.msg,
      })
    } catch (error) {
      log.warn("error resolving feishu bot open_id from bot info", { accountId, error })
    }

    return account.botOpenId
  }

  async connect(input: {
    accountId: string
    accountConfig: Config.ChannelFeishuAccount
    channelConfig: Config.ChannelFeishu
    onMessage: ChannelTypes.MessageHandler
    signal: AbortSignal
  }): Promise<void> {
    const { accountId, accountConfig, channelConfig, onMessage, signal } = input

    const domain = accountConfig.domain ?? channelConfig.domain
    const larkDomain = domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu
    const apiBase = domain === "lark" ? LARK_API_BASE : FEISHU_API_BASE
    const logger = {
      debug: (...args: unknown[]) => log.debug(args.join(" ")),
      info: (...args: unknown[]) => log.info(args.join(" ")),
      warn: (...args: unknown[]) => log.warn(args.join(" ")),
      error: (...args: unknown[]) => log.error(args.join(" ")),
      trace: (...args: unknown[]) => log.debug(args.join(" ")),
    }

    this.accounts.set(accountId, {
      config: accountConfig,
      channelConfig,
      apiBase,
      tokenCache: null,
      botOpenId: normalizeBotOpenId(accountConfig.botOpenId),
      missingBotOpenIdWarned: false,
    })

    await feishuDedup.warmup(accountId).catch((err) => log.warn("dedup warmup failed", { accountId, error: err }))

    const perChatQueue = new Map<string, Promise<void>>()
    const enqueueChatTask = (chatId: string, task: () => Promise<void>) => {
      const prev = perChatQueue.get(chatId) ?? Promise.resolve()
      const next = prev.then(task, task).catch((err) => {
        log.error("chat task failed", { chatId, error: err })
      })
      perChatQueue.set(chatId, next)
      void next.finally(() => {
        if (perChatQueue.get(chatId) === next) perChatQueue.delete(chatId)
      })
      return next
    }

    const debounceMs = accountConfig.inboundDebounceMs ?? 0
    const debouncer = new InboundDebouncer<{ ctx: ChannelTypes.MessageContext }>({
      debounceMs,
      buildKey: (event) => {
        if (debounceMs <= 0) return null
        return `${event.ctx.chatId}:${event.ctx.senderId}`
      },
      resolveText: (event) => event.ctx.text,
      onFlush: async (merged) => {
        const ctx = { ...merged.last.ctx, text: merged.combinedText }
        await enqueueChatTask(ctx.chatId, () => onMessage(ctx))
      },
      onError: (err) => log.error("debounce flush failed", { accountId, error: err }),
    })

    const eventDispatcher = new Lark.EventDispatcher({ logger }).register<{
      "card.action.trigger"?: (data: unknown) => Promise<unknown> | unknown
    }>({
      "im.message.receive_v1": (data: unknown) => {
        const payload = data as FeishuEventPayload
        const message = payload.message ?? payload.event?.message
        const sender = payload.sender ?? payload.event?.sender
        const rawMessageId = message?.message_id ?? "unknown"
        log.info("feishu event received", {
          accountId,
          messageId: rawMessageId,
          chatId: message?.chat_id,
          chatType: message?.chat_type,
        })

        const account = this.accounts.get(accountId)
        if (account && isSelfSender(sender?.sender_type)) {
          const senderOpenId = resolveSenderOpenId(sender)
          if (senderOpenId && account.botOpenId !== senderOpenId) {
            account.botOpenId = senderOpenId
            account.missingBotOpenIdWarned = false
            log.info("learned feishu bot open_id from self event", { accountId, botOpenId: senderOpenId })
          }
        }

        void (async () => {
          try {
            if (await feishuDedup.isDuplicate(accountId, rawMessageId)) {
              log.warn("duplicate message ignored", { messageId: rawMessageId })
              return
            }

            const ctx = await this.buildMessageContext(accountId, accountConfig, channelConfig, payload)
            if (!ctx) {
              log.warn("message filtered out", { accountId, messageId: rawMessageId })
              return
            }

            log.info("queued message", { messageId: ctx.messageId, text: ctx.text.slice(0, 100) })

            if (debounceMs > 0) {
              debouncer.enqueue({ ctx })
            } else {
              await enqueueChatTask(ctx.chatId, () => onMessage(ctx))
            }
          } catch (err) {
            log.error("failed to process message", { messageId: rawMessageId, error: err })
          }
        })()
      },
      "card.action.trigger": async (data: unknown) => {
        log.info("feishu card action received", { accountId })
        for (const handler of FeishuProvider.cardActionHandlers) {
          try {
            const result = await handler(data, accountId)
            if (result !== undefined) return result
          } catch (err) {
            log.error("card action handler error", { accountId, error: err })
          }
        }
      },
    })

    const wsClient = new Lark.WSClient({
      appId: accountConfig.appId,
      appSecret: accountConfig.appSecret,
      domain: larkDomain,
      logger,
    })

    // The Lark SDK's WSClient.handleEventData only processes messages where
    // the header type is "event". Card action callbacks arrive as type "card"
    // and are silently dropped. Monkey-patch handleEventData to rewrite
    // "card" → "event" so the EventDispatcher can route card.action.trigger.
    const wsClientAny = wsClient as any
    const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny)
    wsClientAny.handleEventData = (data: any) => {
      const msgType = data.headers?.find?.((h: any) => h.key === "type")?.value
      if (msgType === "card") {
        const patchedData = {
          ...data,
          headers: data.headers.map((h: any) => (h.key === "type" ? { ...h, value: "event" } : h)),
        }
        return origHandleEventData(patchedData)
      }
      return origHandleEventData(data)
    }

    signal.addEventListener(
      "abort",
      () => {
        log.info("feishu channel aborted", { accountId })
        debouncer.flush().catch(() => {})
        this.accounts.delete(accountId)
      },
      { once: true },
    )

    log.info("starting feishu websocket", { accountId, domain })
    await wsClient.start({ eventDispatcher })
    log.info("feishu websocket connected", { accountId })
  }

  private async buildMessageContext(
    accountId: string,
    accountConfig: Config.ChannelFeishuAccount,
    channelConfig: Config.ChannelFeishu,
    payload: FeishuEventPayload,
  ): Promise<ChannelTypes.MessageContext | null> {
    const message = payload.message ?? payload.event?.message
    const sender = payload.sender ?? payload.event?.sender

    if (!message?.chat_id) return null

    log.info("feishu buildMessageContext entered", {
      accountId,
      messageId: message.message_id,
      chatId: message.chat_id,
      messageType: message.message_type,
      senderType: sender?.sender_type,
    })

    if (isSelfSender(sender?.sender_type)) {
      log.info("feishu self message ignored", {
        accountId,
        messageId: message.message_id,
        chatId: message.chat_id,
        senderType: sender?.sender_type,
      })
      return null
    }

    const isGroup = message.chat_type === "group"
    const mentions = message.mentions ?? []
    const account = this.accounts.get(accountId)

    if (isGroup && !accountConfig.allowGroup) return null
    if (!isGroup && !accountConfig.allowDM) return null

    const botOpenId =
      isGroup && accountConfig.requireMention ? await this.ensureBotOpenId(accountId) : account?.botOpenId
    const wasMentioned = isBotMentioned(mentions, botOpenId)

    if (isGroup && accountConfig.requireMention && !botOpenId) {
      if (account && !account.missingBotOpenIdWarned) {
        account.missingBotOpenIdWarned = true
        log.warn("feishu group mention filtering requires a resolvable bot open_id", { accountId })
      }
      return null
    }
    if (isGroup && accountConfig.requireMention && !wasMentioned) return null

    const messageType = message.message_type ?? "text"
    const rawContent = message.content ?? ""
    log.info("feishu message payload", {
      accountId,
      messageId: message.message_id,
      messageType,
      chatId: message.chat_id,
      contentPreview: rawContent.slice(0, 800),
    })
    const senderId = sender?.sender_id?.open_id || "unknown"

    let text = parseMessageContent(rawContent, messageType)
    if (TEXT_MESSAGE_TYPES.has(messageType)) {
      text = normalizeMentions(text, mentions)
    }
    if (!text) return null

    if (MEDIA_MESSAGE_TYPES.has(messageType)) {
      log.info("feishu media eligibility", {
        accountId,
        messageId: message.message_id,
        messageType,
        hasAccount: Boolean(account),
      })
    }

    const senderNamePromise =
      account && (accountConfig.resolveSenderNames ?? true)
        ? senderNameCache
            .resolve({ apiBase: account.apiBase, getAccessToken: () => this.getAccessToken(accountId) }, senderId)
            .catch(() => undefined)
        : Promise.resolve(undefined)

    const apiCtx = account
      ? { apiBase: account.apiBase, getAccessToken: () => this.getAccessToken(accountId) }
      : undefined

    const quotedContentPromise =
      message.parent_id && apiCtx ? fetchQuotedContent(apiCtx, message.parent_id) : Promise.resolve(undefined)

    const attachmentsPromise = (async (): Promise<ChannelTypes.Attachment[] | undefined> => {
      if (!apiCtx) return undefined
      const msgId = message.message_id ?? ""
      const results: ChannelTypes.Attachment[] = []

      if (MEDIA_MESSAGE_TYPES.has(messageType)) {
        const media = await downloadMessageMedia({
          ctx: apiCtx,
          messageId: msgId,
          messageType,
          content: rawContent,
        })
        if (media) {
          const tmpPath = path.join(os.tmpdir(), `synergy-feishu-${Date.now()}-${msgId}`)
          await Bun.write(tmpPath, media.buffer)
          results.push({ path: tmpPath, contentType: media.contentType, filename: media.fileName })
        }
      }

      if (messageType === "post") {
        const imageKeys = extractPostImageKeys(rawContent)
        if (imageKeys.length > 0) {
          const downloads = await Promise.all(
            imageKeys.map((imageKey) => downloadImageByKey({ ctx: apiCtx, messageId: msgId, imageKey })),
          )
          for (let i = 0; i < downloads.length; i++) {
            const img = downloads[i]
            if (!img) continue
            const tmpPath = path.join(os.tmpdir(), `synergy-feishu-${Date.now()}-${msgId}-img${i}`)
            await Bun.write(tmpPath, img.buffer)
            results.push({ path: tmpPath, contentType: img.contentType })
          }
        }
      }

      return results.length > 0 ? results : undefined
    })()

    const [senderName, quotedContent, attachments] = await Promise.all([
      senderNamePromise,
      quotedContentPromise,
      attachmentsPromise,
    ])

    if (MEDIA_MESSAGE_TYPES.has(messageType) || messageType === "post") {
      log.info("feishu media resolved", {
        accountId,
        messageId: message.message_id,
        messageType,
        attachmentCount: attachments?.length ?? 0,
      })
    }

    const groupScope = accountConfig.groupSessionScope ?? "group"
    const scopeKey = isGroup
      ? resolveGroupScopeKey({
          chatId: message.chat_id,
          senderId,
          rootId: message.root_id,
          threadId: message.thread_id,
          scope: groupScope,
        })
      : undefined

    return {
      channelType: "feishu",
      accountId,
      chatId: message.chat_id,
      chatType: isGroup ? "group" : "dm",
      senderId,
      senderName: senderName ?? sender?.sender_id?.user_id,
      text,
      messageId: message.message_id || "",
      timestamp: Number(message.create_time) || Date.now(),
      wasMentioned,
      messageType,
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      mentions: mentions.map((m) => ({
        key: m.key,
        id: m.id.open_id,
        name: m.name,
      })),
      quotedContent,
      attachments,
      scopeKey,
    }
  }

  async pushMessage(input: {
    accountId: string
    chatId: string
    parts: ChannelTypes.OutboundPart[]
  }): Promise<ChannelTypes.SendResult> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)

    return sendParts({
      parts: input.parts,
      mediaContext: { apiBase: account.apiBase, getAccessToken: () => this.getAccessToken(input.accountId) },
      sendText: (text) =>
        this.sendCreateMessage(input.accountId, input.chatId, { msgType: "text", content: JSON.stringify({ text }) }),
      sendMessage: (message) => this.sendCreateMessage(input.accountId, input.chatId, message),
    })
  }

  async replyMessage(input: {
    accountId: string
    messageId: string
    parts: ChannelTypes.OutboundPart[]
  }): Promise<ChannelTypes.SendResult> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)

    return sendParts({
      parts: input.parts,
      mediaContext: { apiBase: account.apiBase, getAccessToken: () => this.getAccessToken(input.accountId) },
      sendText: (text) =>
        this.sendReplyMessage(input.accountId, input.messageId, { msgType: "text", content: JSON.stringify({ text }) }),
      sendMessage: (message) => this.sendReplyMessage(input.accountId, input.messageId, message),
    })
  }

  private async sendCreateMessage(accountId: string, chatId: string, payload: FeishuMessagePayload) {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Feishu account not found: ${accountId}`)

    const token = await this.getAccessToken(accountId)
    const response = await fetch(`${account.apiBase}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        content: payload.content,
        msg_type: payload.msgType,
      }),
    })

    const result = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
    if (result.code !== 0) {
      throw new Error(`Push failed: ${result.msg ?? `code ${result.code}`}`)
    }

    return { messageId: result.data?.message_id ?? "" }
  }

  private async sendReplyMessage(accountId: string, messageId: string, payload: FeishuMessagePayload) {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Feishu account not found: ${accountId}`)

    const token = await this.getAccessToken(accountId)
    const response = await fetch(`${account.apiBase}/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: payload.content,
        msg_type: payload.msgType,
      }),
    })

    const result = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
    if (result.code !== 0) {
      throw new Error(`Reply failed: ${result.msg ?? `code ${result.code}`}`)
    }

    return { messageId: result.data?.message_id ?? "" }
  }

  async addReaction(input: {
    accountId: string
    messageId: string
    emoji: string
  }): Promise<{ reactionId: string } | void> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)

    const token = await this.getAccessToken(input.accountId)
    const response = await fetch(`${account.apiBase}/im/v1/messages/${input.messageId}/reactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reaction_type: { emoji_type: input.emoji },
      }),
    })

    const result = (await response.json()) as { code?: number; msg?: string; data?: { reaction_id?: string } }
    if (result.code !== 0) {
      throw new Error(`Add reaction failed: ${result.msg ?? `code ${result.code}`}`)
    }

    return { reactionId: result.data?.reaction_id ?? "" }
  }

  async removeReaction(input: { accountId: string; messageId: string; reactionId: string }): Promise<void> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)

    const token = await this.getAccessToken(input.accountId)
    const response = await fetch(`${account.apiBase}/im/v1/messages/${input.messageId}/reactions/${input.reactionId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const result = (await response.json()) as { code?: number; msg?: string }
    if (result.code !== 0) {
      throw new Error(`Remove reaction failed: ${result.msg ?? `code ${result.code}`}`)
    }
  }

  createStreamingSession(input: {
    accountId: string
    chatId: string
    replyToMessageId?: string
  }): ChannelTypes.StreamingSession {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)

    const streamingEnabled = account.config.streaming ?? account.channelConfig.streaming ?? true
    if (!streamingEnabled) {
      return new NonStreamingSession(async (text) => {
        if (input.replyToMessageId) {
          await this.sendReplyMessage(input.accountId, input.replyToMessageId, {
            msgType: "text",
            content: JSON.stringify({ text }),
          })
          return
        }
        await this.sendCreateMessage(input.accountId, input.chatId, {
          msgType: "text",
          content: JSON.stringify({ text }),
        })
      })
    }

    return new FeishuStreamingCard({
      apiBase: account.apiBase,
      getAccessToken: () => this.getAccessToken(input.accountId),
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      replyInThread: account.config.replyInThread,
      throttleMs: account.config.streamingThrottleMs,
    })
  }
}

type FeishuMessagePayload = {
  msgType: "text" | "image" | "file" | "audio" | "media"
  content: string
}

async function sendParts(input: {
  parts: ChannelTypes.OutboundPart[]
  mediaContext: FeishuApiContext
  sendText: (text: string) => Promise<ChannelTypes.SendResult>
  sendMessage: (message: FeishuMessagePayload) => Promise<ChannelTypes.SendResult>
}) {
  let lastResult: ChannelTypes.SendResult | undefined

  for (const part of input.parts) {
    if (part.type === "text") {
      if (!part.text.trim()) continue
      lastResult = await input.sendText(part.text)
      continue
    }

    const prepared = await FeishuOutboundMedia.prepare(part, input.mediaContext)
    lastResult = await input.sendMessage(prepared)
  }

  if (lastResult) return lastResult
  throw new Error("Cannot send an empty outbound message")
}

class NonStreamingSession implements ChannelTypes.StreamingSession {
  constructor(private readonly send: (text: string) => Promise<void>) {}

  async start(): Promise<void> {}

  async update(_text: string): Promise<void> {}

  async updateToolProgress(_progress: ChannelTypes.StreamingToolProgress[]): Promise<void> {}

  async close(finalText?: string): Promise<void> {
    if (finalText) await this.send(finalText)
  }

  isActive(): boolean {
    return false
  }
}

// Expose card action registration globally so plugins can register handlers
// without importing FeishuProvider (which uses @/ path aliases not available in plugins).
;(globalThis as any).__synergy_feishu_onCardAction = FeishuProvider.onCardAction.bind(FeishuProvider)

// Consume any pending card action handler that was stored by a plugin before this module loaded.
// This handles the timing issue where Plugin.init() runs before ChannelBootstrap().
const pendingHandler = (globalThis as any).__synergy_feishu_pendingCardActionHandler as
  | ((data: unknown, accountId: string) => Promise<unknown>)
  | undefined
if (pendingHandler) {
  FeishuProvider.onCardAction(pendingHandler)
  delete (globalThis as any).__synergy_feishu_pendingCardActionHandler
}
