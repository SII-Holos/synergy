import os from "os"
import fs from "fs/promises"
import path from "path"
import * as Lark from "@larksuiteoapi/node-sdk"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import * as ChannelTypes from "../../types"
import type { ChannelHost } from "../../host"
import { FeishuStreamingCard } from "./streaming-card"
import { FeishuStreamingState } from "./streaming-state"
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
const ACCOUNT_DRAIN_TIMEOUT_MS = 30_000

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

type FeishuInboundEvent = { ctx: ChannelTypes.MessageContext }

type AccountRuntime = {
  acceptingInbound: boolean
  inboundTasks: Set<Promise<void>>
  perChatQueue: Map<string, Promise<void>>
  debouncer?: InboundDebouncer<FeishuInboundEvent>
  wsClient?: Lark.WSClient
  tokenRefreshTimer?: ReturnType<typeof setTimeout>
  drain?: Promise<void>
}

type AccountState = {
  config: Config.ChannelFeishuAccount
  channelConfig: Config.ChannelFeishu
  apiBase: string
  tokenCache: { token: string; expiresAt: number } | null
  botOpenId?: string
  missingBotOpenIdWarned?: boolean
  runtime: AccountRuntime
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
  readonly lifecycle = "self_connected" as const
  readonly conversation = {
    replyMessage: (input: Parameters<FeishuProvider["replyMessage"]>[0]) => this.replyMessage(input),
    pushMessage: (input: Parameters<FeishuProvider["pushMessage"]>[0]) => this.pushMessage(input),
    addReaction: (input: Parameters<FeishuProvider["addReaction"]>[0]) => this.addReaction(input),
    removeReaction: (input: Parameters<FeishuProvider["removeReaction"]>[0]) => this.removeReaction(input),
    createStreamingSession: (input: Parameters<FeishuProvider["createStreamingSession"]>[0]) =>
      this.createStreamingSession(input),
  } satisfies ChannelTypes.ConversationCapabilities

  private accounts = new Map<string, AccountState>()

  private static cardActionHandlers: FeishuCardActionHandler[] = []

  static onCardAction(handler: (data: unknown, accountId: string) => Promise<unknown>): () => void {
    FeishuProvider.cardActionHandlers.push(handler)
    return () => {
      FeishuProvider.cardActionHandlers = FeishuProvider.cardActionHandlers.filter((h) => h !== handler)
    }
  }

  private scheduleTokenRefresh(accountId: string, expiresInMs: number) {
    const account = this.accounts.get(accountId)
    if (!account) return
    if (account.runtime.tokenRefreshTimer) clearTimeout(account.runtime.tokenRefreshTimer)
    const refreshIn = Math.max(expiresInMs - 120_000, 30_000)
    const timer = setTimeout(() => {
      account.runtime.tokenRefreshTimer = undefined
      this.refreshToken(accountId).catch(() => {})
    }, refreshIn)
    account.runtime.tokenRefreshTimer = timer
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

    if (this.accounts.get(accountId) !== account) return
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
    const refreshed = this.accounts.get(accountId)
    if (refreshed !== account) throw new Error(`Feishu account not found: ${accountId}`)
    if (!refreshed.tokenCache) throw new Error(`Feishu access token unavailable: ${accountId}`)
    return refreshed.tokenCache.token
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
        return botOpenId
      }
      log.warn("failed to resolve feishu bot open_id", { accountId, code: result.code })
    } catch (error) {
      log.warn("error resolving feishu bot open_id", { accountId, error })
    }
    return account.botOpenId
  }

  async connect(input: {
    accountId: string
    accountConfig: Config.ChannelFeishuAccount
    channelConfig: Config.ChannelFeishu
    signal: AbortSignal
    host: ChannelHost.Instance
    onDisconnect?: (reason?: string) => void
    onResponseCardAction?: (
      callback: ChannelTypes.ResponseCardCallback,
    ) => Promise<ChannelTypes.ResponseCardActionResult>
    onQuestionCardAction?: (
      callback: ChannelTypes.QuestionCardCallback,
    ) => Promise<ChannelTypes.QuestionCardActionResult>
  }): Promise<void> {
    const { accountId, accountConfig, channelConfig, signal, host, onResponseCardAction, onQuestionCardAction } = input

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

    const runtime: AccountRuntime = {
      acceptingInbound: true,
      inboundTasks: new Set(),
      perChatQueue: new Map(),
    }
    const account: AccountState = {
      config: accountConfig,
      channelConfig,
      apiBase,
      tokenCache: null,
      botOpenId: normalizeBotOpenId(accountConfig.botOpenId),
      missingBotOpenIdWarned: false,
      runtime,
    }
    this.accounts.set(accountId, account)

    signal.addEventListener(
      "abort",
      () => {
        log.info("feishu channel aborted", { accountId })
        void this.disconnect({ accountId })
      },
      { once: true },
    )
    if (signal.aborted) {
      await this.disconnect({ accountId })
      return
    }

    await feishuDedup.warmup(accountId).catch((err) => log.warn("dedup warmup failed", { accountId, error: err }))
    await FeishuStreamingState.reconcileAccount({
      accountId,
      apiBase,
      getAccessToken: () => this.getAccessToken(accountId),
    }).catch((error) => log.warn("streaming card recovery failed", { accountId, error }))
    if (signal.aborted || this.accounts.get(accountId) !== account) return

    const enqueueChatTask = (chatId: string, task: () => Promise<void>) => {
      const prev = runtime.perChatQueue.get(chatId) ?? Promise.resolve()
      const next = prev.then(task, task).catch((err) => {
        log.error("chat task failed", { chatId, error: err })
      })
      runtime.perChatQueue.set(chatId, next)
      void next.finally(() => {
        if (runtime.perChatQueue.get(chatId) === next) runtime.perChatQueue.delete(chatId)
      })
      return next
    }

    const debounceMs = accountConfig.inboundDebounceMs ?? 0
    const debouncer = new InboundDebouncer<FeishuInboundEvent>({
      debounceMs,
      buildKey: (event) => {
        if (debounceMs <= 0) return null
        return `${event.ctx.chatId}:${event.ctx.senderId}`
      },
      resolveText: (event) => event.ctx.text,
      onFlush: async (merged) => {
        const ctx = { ...merged.last.ctx, text: merged.combinedText }
        await enqueueChatTask(ctx.chatId, () => host.conversations.receive(ctx))
      },
      onError: (err) => log.error("debounce flush failed", { accountId, error: err }),
    })
    runtime.debouncer = debouncer

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

        const processing = (async () => {
          try {
            if (!runtime.acceptingInbound || signal.aborted || this.accounts.get(accountId) !== account) {
              log.warn("feishu message ignored during account drain", { accountId, messageId: rawMessageId })
              return
            }
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
              await enqueueChatTask(ctx.chatId, () => host.conversations.receive(ctx))
            }
          } catch (err) {
            log.error("failed to process message", { messageId: rawMessageId, error: err })
          }
        })()
        runtime.inboundTasks.add(processing)
        void processing.finally(() => runtime.inboundTasks.delete(processing))
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
    runtime.wsClient = wsClient

    if (signal.aborted || this.accounts.get(accountId) !== account) {
      await this.disconnect({ accountId })
      return
    }
    log.info("starting feishu websocket", { accountId, domain })
    try {
      await wsClient.start({ eventDispatcher })
    } catch (error) {
      await this.disconnect({ accountId })
      log.error("feishu ws start failed", { accountId, error })
      throw error
    }
    if (!signal.aborted && this.accounts.get(accountId) === account) {
      log.info("feishu websocket connected", { accountId })
    }
  }

  async disconnect(input: { accountId: string }): Promise<void> {
    const account = this.accounts.get(input.accountId)
    if (!account) return
    const runtime = account.runtime
    if (runtime.drain) return runtime.drain

    runtime.acceptingInbound = false
    runtime.drain = (async () => {
      if (runtime.tokenRefreshTimer) {
        clearTimeout(runtime.tokenRefreshTimer)
        runtime.tokenRefreshTimer = undefined
      }
      try {
        runtime.wsClient?.close()
      } catch (error) {
        log.warn("failed to close feishu websocket", { accountId: input.accountId, error })
      } finally {
        runtime.wsClient = undefined
      }

      const drainTasks = async (tasks: Set<Promise<void>>) => {
        while (tasks.size > 0) {
          const pending = Array.from(tasks)
          if (pending.length === 0) break
          await Promise.allSettled(pending)
          await Promise.resolve()
        }
      }
      const drain = async () => {
        await drainTasks(runtime.inboundTasks)
        await runtime.debouncer?.flush()
        while (runtime.perChatQueue.size > 0) {
          const pending = Array.from(new Set(runtime.perChatQueue.values()))
          if (pending.length === 0) break
          await Promise.allSettled(pending)
          await Promise.resolve()
        }
      }

      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), ACCOUNT_DRAIN_TIMEOUT_MS)
        timeout.unref()
      })
      try {
        const result = await Promise.race([drain().then(() => false as const), timedOut])
        if (result) {
          log.warn("feishu account drain timed out", {
            accountId: input.accountId,
            timeoutMs: ACCOUNT_DRAIN_TIMEOUT_MS,
            pendingChats: runtime.perChatQueue.size,
          })
        }
      } catch (error) {
        log.warn("feishu account drain failed", { accountId: input.accountId, error })
      } finally {
        if (timeout) clearTimeout(timeout)
        if (this.accounts.get(input.accountId) === account) this.accounts.delete(input.accountId)
      }
    })()

    return runtime.drain
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
    const senderId =
      sender?.sender_id?.open_id || sender?.sender_id?.union_id || sender?.sender_id?.user_id || "unknown"

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
      senderName: senderName ?? senderId,
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
    sessionID: string
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
      persistence: { accountId: input.accountId, sessionID: input.sessionID },
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
