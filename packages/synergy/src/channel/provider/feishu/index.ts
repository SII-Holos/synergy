import os from "os"
import fs from "fs/promises"
import path from "path"
import * as Lark from "@larksuiteoapi/node-sdk"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import * as ChannelTypes from "../../types"
import { FeishuStreamingCard } from "./streaming-card"
import { feishuDedup } from "./dedup"
import { senderNameCache, chatNameCache } from "./sender"
import { InboundDebouncer } from "./debounce"
import {
  parseMessageContent,
  normalizeMentions,
  fetchQuotedMessage,
  downloadMessageMedia,
  extractPostImageKeys,
  downloadImageByKey,
  MAX_FEISHU_ATTACHMENT_BYTES,
  type DownloadedMedia,
  type QuotedMessage,
} from "./message"
import type { FeishuEventPayload, FeishuMessage, FeishuMention, FeishuSender } from "./feishu-types"
import type { FeishuApiContext } from "./api-context"
import { FeishuOutboundMedia } from "./outbound-media"
import { parseFeishuResponseCardAction, renderFeishuResponseCard, sendFeishuResponseCard } from "./response-card"
import { parseFeishuQuestionCardAction, renderFeishuQuestionCard, sendFeishuQuestionCard } from "./question-card"

export {
  parseFeishuQuestionCardAction,
  parseFeishuResponseCardAction,
  renderFeishuQuestionCard,
  renderFeishuResponseCard,
  sendFeishuQuestionCard,
}

const log = Log.create({ service: "channel.feishu" })

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
const LARK_API_BASE = "https://open.larksuite.com/open-apis"
const TEXT_MESSAGE_TYPES = new Set(["text", "post"])
const MEDIA_MESSAGE_TYPES = new Set(["image", "file", "audio", "media", "video", "sticker"])
const SELF_SENDER_TYPES = new Set(["app", "bot", "app_bot"])
const MAX_FEISHU_ATTACHMENTS = 8
const API_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_REQUEST_TIMEOUT_MS = 10_000

type FeishuCardActionHandler = (data: unknown, accountId: string) => Promise<unknown>

export async function routeFeishuCardAction(input: {
  data: unknown
  accountId: string
  onResponseCardAction?: (callback: ChannelTypes.ResponseCardCallback) => Promise<ChannelTypes.ResponseCardActionResult>
  onQuestionCardAction?: (callback: ChannelTypes.QuestionCardCallback) => Promise<ChannelTypes.QuestionCardActionResult>
  pluginHandlers?: readonly FeishuCardActionHandler[]
}): Promise<unknown> {
  const parsed = parseFeishuResponseCardAction(input.data)
  if (parsed.status === "invalid") {
    return { toast: { type: "warning", content: "此操作无效，请使用最新卡片重试" } }
  }
  if (parsed.status === "valid") {
    if (!input.onResponseCardAction) {
      return { toast: { type: "warning", content: "此操作已失效，请使用最新卡片重试" } }
    }
    const result = await input.onResponseCardAction(parsed.callback)
    if (result.status === "accepted") {
      return { toast: { type: "success", content: "操作已接收" } }
    }
    if (result.status === "duplicate") {
      return { toast: { type: "info", content: "操作已接收" } }
    }
    return { toast: { type: "warning", content: "此操作已失效，请使用最新卡片重试" } }
  }

  const question = parseFeishuQuestionCardAction(input.data)
  if (question.status === "invalid") {
    return { toast: { type: "warning", content: "此问题已失效，请使用最新卡片重试" } }
  }
  if (question.status === "valid") {
    if (!input.onQuestionCardAction) {
      return { toast: { type: "warning", content: "此问题已失效，请使用最新卡片重试" } }
    }
    const result = await input.onQuestionCardAction(question.callback)
    if (result.status === "accepted") {
      return { toast: { type: "success", content: "回答已提交" } }
    }
    if (result.status === "duplicate") {
      return { toast: { type: "info", content: "回答已提交" } }
    }
    return { toast: { type: "warning", content: "此问题已失效，请使用最新卡片重试" } }
  }

  for (const handler of input.pluginHandlers ?? []) {
    try {
      const result = await handler(input.data, input.accountId)
      if (result !== undefined) return result
    } catch (err) {
      log.error("card action handler error", { accountId: input.accountId, error: err })
    }
  }
}

type InboundAttachmentSource = {
  messageId: string
  messageType: string
  content: string
  quoted: boolean
}

async function materializeInboundAttachments(input: {
  ctx: FeishuApiContext
  current: InboundAttachmentSource
  quoted?: QuotedMessage
}): Promise<ChannelTypes.Attachment[] | undefined> {
  const attachments: ChannelTypes.Attachment[] = []
  const materializedPaths: string[] = []
  let remainingBytes = MAX_FEISHU_ATTACHMENT_BYTES

  const addMedia = async (
    media: DownloadedMedia | undefined,
    source: InboundAttachmentSource,
    fallbackName?: string,
  ) => {
    if (!media || attachments.length >= MAX_FEISHU_ATTACHMENTS || media.size > remainingBytes) return

    const filename = media.fileName ?? fallbackName
    const tmpPath = path.join(os.tmpdir(), `synergy-feishu-${crypto.randomUUID()}`)
    materializedPaths.push(tmpPath)
    await Bun.write(tmpPath, media.buffer)
    attachments.push({
      path: tmpPath,
      contentType: media.contentType,
      filename,
      placeholder: source.quoted ? `Quoted attachment${filename ? `: ${filename}` : ""}` : undefined,
    })
    remainingBytes -= media.size
  }

  const materializeSource = async (source: InboundAttachmentSource) => {
    if (attachments.length >= MAX_FEISHU_ATTACHMENTS || remainingBytes <= 0) return

    if (MEDIA_MESSAGE_TYPES.has(source.messageType)) {
      const media = await downloadMessageMedia({
        ctx: input.ctx,
        messageId: source.messageId,
        messageType: source.messageType,
        content: source.content,
        maxBytes: remainingBytes,
      })
      await addMedia(media, source)
      return
    }

    if (source.messageType !== "post") return
    const imageKeys = extractPostImageKeys(source.content)
    for (let index = 0; index < imageKeys.length; index++) {
      if (attachments.length >= MAX_FEISHU_ATTACHMENTS || remainingBytes <= 0) break
      const image = await downloadImageByKey({
        ctx: input.ctx,
        messageId: source.messageId,
        imageKey: imageKeys[index],
        maxBytes: remainingBytes,
      })
      await addMedia(image, source, `image-${index + 1}.png`)
    }
  }

  try {
    await materializeSource(input.current)
    if (input.quoted) {
      await materializeSource({
        messageId: input.quoted.messageId,
        messageType: input.quoted.messageType,
        content: input.quoted.content,
        quoted: true,
      })
    }
    return attachments.length > 0 ? attachments : undefined
  } catch (error) {
    await Promise.all(materializedPaths.map((filePath) => fs.unlink(filePath).catch(() => {})))
    throw error
  }
}

type AccountState = {
  config: Config.ChannelFeishuAccount
  channelConfig: Config.ChannelFeishu
  apiBase: string
  tokenCache: { token: string; expiresAt: number } | null
  botOpenId?: string
  missingBotOpenIdWarned?: boolean
}

export function resolveGroupScopeKey(input: {
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

export function isSelfSender(senderType?: string): boolean {
  if (!senderType) return false
  return SELF_SENDER_TYPES.has(senderType.toLowerCase())
}

export function isOwnBotMessage(sender?: FeishuSender, botOpenId?: string): boolean {
  if (!isSelfSender(sender?.sender_type)) return false
  const senderOpenId = resolveSenderOpenId(sender)
  return !botOpenId || !senderOpenId || senderOpenId === botOpenId
}

export function normalizeBotOpenId(openId?: string): string | undefined {
  const normalized = openId?.trim()
  return normalized ? normalized : undefined
}

export function resolveSenderOpenId(sender?: FeishuSender): string | undefined {
  return normalizeBotOpenId(sender?.sender_id?.open_id)
}

export function isBotMentioned(mentions: FeishuMention[], botOpenId?: string): boolean {
  if (!botOpenId) return false
  return mentions.some((mention) => normalizeBotOpenId(mention.id.open_id) === botOpenId)
}

export interface MessageFilterInput {
  message: FeishuMessage | undefined
  sender: FeishuSender | undefined
  accountConfig: Config.ChannelFeishuAccount
  botOpenId?: string
}

export interface MessageFilterResult {
  accepted: boolean
  reason?: string
  isGroup: boolean
  wasMentioned: boolean
  needsBotOpenIdResolution: boolean
}

export function filterInboundMessage(input: MessageFilterInput): MessageFilterResult {
  const { message, sender, accountConfig, botOpenId } = input

  if (!message?.chat_id) {
    return {
      accepted: false,
      reason: "missing chat_id",
      isGroup: false,
      wasMentioned: false,
      needsBotOpenIdResolution: false,
    }
  }

  if (isOwnBotMessage(sender, botOpenId)) {
    return {
      accepted: false,
      reason: "self sender",
      isGroup: false,
      wasMentioned: false,
      needsBotOpenIdResolution: false,
    }
  }

  const isGroup = message.chat_type === "group"
  const mentions = message.mentions ?? []

  if (isGroup && !accountConfig.allowGroup) {
    return {
      accepted: false,
      reason: "group not allowed",
      isGroup,
      wasMentioned: false,
      needsBotOpenIdResolution: false,
    }
  }
  if (!isGroup && !accountConfig.allowDM) {
    return { accepted: false, reason: "DM not allowed", isGroup, wasMentioned: false, needsBotOpenIdResolution: false }
  }

  const needsBotOpenIdResolution = isGroup && !!accountConfig.requireMention && !botOpenId
  const effectiveBotOpenId = botOpenId
  const wasMentioned = isBotMentioned(mentions, effectiveBotOpenId)

  if (isGroup && accountConfig.requireMention && !effectiveBotOpenId) {
    return {
      accepted: false,
      reason: "bot open_id unresolvable",
      isGroup,
      wasMentioned: false,
      needsBotOpenIdResolution,
    }
  }
  if (isGroup && accountConfig.requireMention && !wasMentioned) {
    return {
      accepted: false,
      reason: "bot not mentioned",
      isGroup,
      wasMentioned: false,
      needsBotOpenIdResolution: false,
    }
  }

  return { accepted: true, isGroup, wasMentioned, needsBotOpenIdResolution: false }
}

export class FeishuProvider implements ChannelTypes.Provider<Config.ChannelFeishuAccount, Config.ChannelFeishu> {
  readonly type = "feishu"

  private accounts = new Map<string, AccountState>()

  private static cardActionHandlers: FeishuCardActionHandler[] = []

  static onCardAction(handler: (data: unknown, accountId: string) => Promise<unknown>): () => void {
    FeishuProvider.cardActionHandlers.push(handler)
    return () => {
      FeishuProvider.cardActionHandlers = FeishuProvider.cardActionHandlers.filter((h) => h !== handler)
    }
  }

  private scheduleTokenRefresh(accountId: string, expiresInMs: number) {
    const refreshIn = Math.max(expiresInMs - 120_000, 30_000)
    const timer = setTimeout(() => {
      this.refreshToken(accountId).catch(() => {})
    }, refreshIn)
    timer.unref()
  }

  private async refreshToken(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId)
    if (!account) return

    const response = await fetch(`${account.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: account.config.appId,
        app_secret: account.config.appSecret,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })

    const result = (await response.json()) as {
      tenant_access_token: string
      expire: number
    }

    account.tokenCache = {
      token: result.tenant_access_token,
      expiresAt: Date.now() + result.expire * 1000,
    }

    this.scheduleTokenRefresh(accountId, result.expire * 1000)
  }

  private async getAccessToken(accountId: string): Promise<string> {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Feishu account not found: ${accountId}`)

    if (account.tokenCache && account.tokenCache.expiresAt > Date.now() + 60_000) {
      return account.tokenCache.token
    }

    await this.refreshToken(accountId)
    return account.tokenCache!.token
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
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
    onResponseCardAction?: (
      callback: ChannelTypes.ResponseCardCallback,
    ) => Promise<ChannelTypes.ResponseCardActionResult>
    onQuestionCardAction?: (
      callback: ChannelTypes.QuestionCardCallback,
    ) => Promise<ChannelTypes.QuestionCardActionResult>
  }): Promise<void> {
    const { accountId, accountConfig, channelConfig, onMessage, onResponseCardAction, onQuestionCardAction, signal } =
      input

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

            log.debug("queued message", { messageId: ctx.messageId, text: ctx.text.slice(0, 100) })

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
        return routeFeishuCardAction({
          data,
          accountId,
          onResponseCardAction,
          onQuestionCardAction,
          pluginHandlers: FeishuProvider.cardActionHandlers,
        })
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
    const account = this.accounts.get(accountId)

    log.info("feishu buildMessageContext entered", {
      accountId,
      messageId: message?.message_id,
      chatId: message?.chat_id,
      messageType: message?.message_type,
      senderType: sender?.sender_type,
    })

    const isGroup = message?.chat_type === "group"
    const botOpenId =
      isGroup && accountConfig.requireMention ? await this.ensureBotOpenId(accountId) : account?.botOpenId

    const filterResult = filterInboundMessage({ message, sender, accountConfig, botOpenId })

    if (!filterResult.accepted) {
      if (filterResult.reason === "self sender") {
        log.info("feishu self message ignored", {
          accountId,
          messageId: message?.message_id,
          chatId: message?.chat_id,
          senderType: sender?.sender_type,
        })
      }
      if (filterResult.reason === "bot open_id unresolvable" && account && !account.missingBotOpenIdWarned) {
        account.missingBotOpenIdWarned = true
        log.warn("feishu group mention filtering requires a resolvable bot open_id", { accountId })
      }
      return null
    }

    const mentions = message!.mentions ?? []
    const wasMentioned = filterResult.wasMentioned

    // filterInboundMessage guarantees message is defined when accepted
    const msg = message!
    const messageType = msg.message_type ?? "text"
    const rawContent = msg.content ?? ""
    log.debug("feishu message payload", {
      accountId,
      messageId: msg.message_id,
      messageType,
      chatId: msg.chat_id,
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
        messageId: msg.message_id,
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

    const quotedMessagePromise: Promise<QuotedMessage | undefined> =
      msg.parent_id && apiCtx ? fetchQuotedMessage(apiCtx, msg.parent_id) : Promise.resolve(undefined)

    const attachmentsPromise = apiCtx
      ? quotedMessagePromise.then((quotedMessage) =>
          materializeInboundAttachments({
            ctx: apiCtx,
            current: {
              messageId: msg.message_id ?? "",
              messageType,
              content: rawContent,
              quoted: false,
            },
            quoted: quotedMessage,
          }),
        )
      : Promise.resolve(undefined)

    const chatNamePromise =
      account && filterResult.isGroup && msg.chat_id
        ? chatNameCache.resolve(apiCtx!, msg.chat_id!).catch(() => undefined)
        : Promise.resolve(undefined)

    const [senderName, quotedMessage, attachments, resolvedChatName] = await Promise.all([
      senderNamePromise,
      quotedMessagePromise,
      attachmentsPromise,
      chatNamePromise,
    ])
    const quotedContent = quotedMessage?.text

    const chatName = resolvedChatName ?? senderName

    if (MEDIA_MESSAGE_TYPES.has(messageType) || messageType === "post") {
      log.info("feishu media resolved", {
        accountId,
        messageId: msg.message_id,
        messageType,
        attachmentCount: attachments?.length ?? 0,
      })
    }

    const groupScope = accountConfig.groupSessionScope ?? "group"
    const scopeKey = filterResult.isGroup
      ? resolveGroupScopeKey({
          chatId: msg.chat_id!,
          senderId,
          rootId: msg.root_id,
          threadId: msg.thread_id,
          scope: groupScope,
        })
      : undefined

    return {
      channelType: "feishu",
      accountId,
      chatId: msg.chat_id!,
      chatType: filterResult.isGroup ? "group" : "dm",
      chatName,
      senderId,
      senderName: senderName ?? sender?.sender_id?.user_id,
      text,
      messageId: msg.message_id || "",
      timestamp: Number(msg.create_time) || Date.now(),
      wasMentioned,
      messageType,
      rootId: msg.root_id,
      parentId: msg.parent_id,
      threadId: msg.thread_id,
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

  async sendResponseCard(input: {
    accountId: string
    chatId: string
    replyToMessageId?: string
    requestId: string
    card: ChannelTypes.ResponseCard
  }): Promise<ChannelTypes.SendResult> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)
    return sendFeishuResponseCard({
      apiBase: account.apiBase,
      getAccessToken: () => this.getAccessToken(input.accountId),
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      replyInThread: account.config.replyInThread,
      requestId: input.requestId,
      card: input.card,
    })
  }

  async sendQuestionCard(input: {
    accountId: string
    chatId: string
    replyToMessageId?: string
    requestId: string
    questions: import("@/question").Question.Info[]
  }): Promise<ChannelTypes.SendResult> {
    const account = this.accounts.get(input.accountId)
    if (!account) throw new Error(`Feishu account not found: ${input.accountId}`)
    return sendFeishuQuestionCard({
      apiBase: account.apiBase,
      getAccessToken: () => this.getAccessToken(input.accountId),
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      replyInThread: account.config.replyInThread,
      requestId: input.requestId,
      questions: input.questions,
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
        ...(account.config.replyInThread ? { reply_in_thread: true } : {}),
      }),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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

    const sendText = async (text: string) => {
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
    }

    const streamingEnabled = account.config.streaming ?? account.channelConfig.streaming ?? true
    if (!streamingEnabled) return new NonStreamingSession(sendText)

    return new FeishuStreamingCard({
      apiBase: account.apiBase,
      getAccessToken: () => this.getAccessToken(input.accountId),
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      replyInThread: account.config.replyInThread,
      throttleMs: account.config.streamingThrottleMs,
      sendFallback: sendText,
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

  async close(finalText?: string, _error?: boolean): Promise<void> {
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
// This handles the timing issue where Plugin.init() runs before GlobalRuntime starts channels.
const pendingHandler = (globalThis as any).__synergy_feishu_pendingCardActionHandler as
  | ((data: unknown, accountId: string) => Promise<unknown>)
  | undefined
if (pendingHandler) {
  FeishuProvider.onCardAction(pendingHandler)
  delete (globalThis as any).__synergy_feishu_pendingCardActionHandler
}
