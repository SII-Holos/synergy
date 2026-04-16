import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Instance } from "../scope/instance"
import { Scope } from "@/scope"

import { Config } from "../config/config"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInteraction } from "../session/interaction"
import { SessionInvoke, InvokeInput } from "../session/invoke"

import { ChannelCommand } from "./command"
import { createStatusReactionController } from "./status-reactions"
import {
  Info as InfoSchema,
  Status as StatusSchema,
  Mention as MentionSchema,
  Attachment as AttachmentSchema,
  MessageContext as MessageContextSchema,
  toKey as toKeyFn,
} from "./types"
import type {
  Info as InfoType,
  Status as StatusType,
  Mention as MentionType,
  Attachment as AttachmentType,
  MessageContext as MessageContextType,
  MessageHandler as MessageHandlerType,
  SendResult as SendResultType,
  StreamingSession as StreamingSessionType,
  Provider as ProviderType,
} from "./types"

export namespace Channel {
  const log = Log.create({ service: "channel" })
  const RECONNECT_DELAY_MS = 2_000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const MAX_RECONNECT_ATTEMPTS = 50

  export const Info = InfoSchema
  export const Status = StatusSchema
  export const Mention = MentionSchema
  export const Attachment = AttachmentSchema
  export const MessageContext = MessageContextSchema
  export type Info = InfoType
  export type Status = StatusType
  export type Mention = MentionType
  export type Attachment = AttachmentType
  export type MessageContext = MessageContextType
  export type MessageHandler = MessageHandlerType
  export type SendResult = SendResultType
  export type StreamingSession = StreamingSessionType
  export type Provider = ProviderType

  export const toKey = toKeyFn

  export const StartError = NamedError.create(
    "ChannelStartError",
    z.object({
      message: z.string(),
      channelType: z.string(),
      accountId: z.string().optional(),
    }),
  )

  export const Event = {
    Connected: BusEvent.define(
      "channel.connected",
      z.object({
        channelType: z.string(),
        accountId: z.string(),
      }),
    ),
    Disconnected: BusEvent.define(
      "channel.disconnected",
      z.object({
        channelType: z.string(),
        accountId: z.string(),
        reason: z.string().optional(),
      }),
    ),
    MessageReceived: BusEvent.define(
      "channel.message.received",
      z.object({
        channelType: z.string(),
        accountId: z.string(),
        chatId: z.string(),
        text: z.string(),
      }),
    ),
  }

  type Connection = {
    channelType: string
    accountId: string
    provider: Provider
    abort: AbortController
    status: Status
  }

  type State = {
    connections: Map<string, Connection>
    statuses: Map<string, Status>
    reconnects: Map<string, ReturnType<typeof setTimeout>>
  }

  function connectionKey(channelType: string, accountId: string): string {
    return `${channelType}:${accountId}`
  }

  const providers = new Map<string, Provider>()

  export function registerProvider(provider: Provider): void {
    providers.set(provider.type, provider)
  }

  export function getProvider(type: string): Provider | undefined {
    return providers.get(type)
  }

  const state = Instance.state(
    async (): Promise<State> => {
      const scope = Scope.global()
      const cfg = await Config.get()
      const channels = cfg.channel ?? {}
      const connections = new Map<string, Connection>()
      const statuses = new Map<string, Status>()
      const reconnects = new Map<string, ReturnType<typeof setTimeout>>()

      for (const [channelType, channelConfig] of Object.entries(channels)) {
        const provider = providers.get(channelType)
        if (!provider) {
          log.warn("unknown channel type, skipping", { channelType })
          continue
        }

        const accounts = "accounts" in channelConfig ? channelConfig.accounts : {}
        for (const [accountId, accountConfig] of Object.entries(accounts)) {
          const key = connectionKey(channelType, accountId)

          if ("enabled" in accountConfig && accountConfig.enabled === false) {
            statuses.set(key, { status: "disabled" })
            continue
          }

          statuses.set(key, { status: "connecting" })
          const abort = new AbortController()

          connectAccount({
            channelType,
            accountId,
            accountConfig,
            channelConfig,
            provider,
            abort,
            connections,
            statuses,
            reconnects,
            scope,
          }).catch((err) => {
            const error = err instanceof Error ? err.message : String(err)
            log.error("channel connection failed", { channelType, accountId, error })
            statuses.set(key, { status: "failed", error })
          })
        }
      }

      return { connections, statuses, reconnects }
    },
    async (s) => {
      for (const timer of s.reconnects.values()) clearTimeout(timer)
      for (const conn of s.connections.values()) {
        conn.abort.abort()
        Bus.publish(Event.Disconnected, {
          channelType: conn.channelType,
          accountId: conn.accountId,
          reason: "shutdown",
        })
      }
    },
  )

  export async function reload() {
    log.info("reloading channel state")
    await state.resetAll()
    log.info("channel state reloaded")
  }

  async function connectAccount(input: {
    channelType: string
    accountId: string
    accountConfig: unknown
    channelConfig: Config.Channel
    provider: Provider
    abort: AbortController
    connections: Map<string, Connection>
    statuses: Map<string, Status>
    reconnects: Map<string, ReturnType<typeof setTimeout>>
    scope: Scope
    attempt?: number
  }): Promise<void> {
    const {
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      abort,
      connections,
      statuses,
      reconnects,
      scope,
      attempt = 0,
    } = input
    const key = connectionKey(channelType, accountId)

    const reconnectTimer = reconnects.get(key)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnects.delete(key)
    }

    await provider.connect({
      accountId,
      accountConfig,
      channelConfig,
      onMessage: (ctx) => handleMessage(provider, ctx, scope),
      signal: abort.signal,
      onDisconnect: (reason) => {
        if (abort.signal.aborted) return
        log.info("channel disconnected", { channelType, accountId, reason })
        connections.delete(key)
        statuses.set(key, { status: "disconnected" })
        Bus.publish(Event.Disconnected, { channelType, accountId, reason })
        scheduleReconnect({
          channelType,
          accountId,
          accountConfig,
          channelConfig,
          provider,
          abort,
          connections,
          statuses,
          reconnects,
          scope,
          attempt: 0,
        })
      },
    })

    connections.set(key, {
      channelType,
      accountId,
      provider,
      abort,
      status: { status: "connected" },
    })
    statuses.set(key, { status: "connected" })
    reconnects.delete(key)

    log.info("channel connected", { channelType, accountId })
    Bus.publish(Event.Connected, { channelType, accountId })
  }

  function scheduleReconnect(input: {
    channelType: string
    accountId: string
    accountConfig: unknown
    channelConfig: Config.Channel
    provider: Provider
    abort: AbortController
    connections: Map<string, Connection>
    statuses: Map<string, Status>
    reconnects: Map<string, ReturnType<typeof setTimeout>>
    scope: Scope
    attempt: number
  }): void {
    const {
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      abort,
      connections,
      statuses,
      reconnects,
      scope,
      attempt,
    } = input
    if (abort.signal.aborted) return

    const key = connectionKey(channelType, accountId)

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      log.warn("max reconnect attempts exceeded", { channelType, accountId, attempt })
      statuses.set(key, { status: "failed", error: "max reconnect attempts exceeded" })
      return
    }

    const existingTimer = reconnects.get(key)
    if (existingTimer) clearTimeout(existingTimer)

    const delayMs = Math.min(RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
    statuses.set(key, { status: "connecting" })

    const timer = setTimeout(() => {
      reconnects.delete(key)
      if (abort.signal.aborted) return

      connectAccount({
        channelType,
        accountId,
        accountConfig,
        channelConfig,
        provider,
        abort,
        connections,
        statuses,
        reconnects,
        scope,
        attempt: attempt + 1,
      }).catch((err) => {
        const error = err instanceof Error ? err.message : String(err)
        log.warn("channel reconnect failed", { channelType, accountId, attempt: attempt + 1, error })
        statuses.set(key, { status: "failed", error })
        scheduleReconnect({
          channelType,
          accountId,
          accountConfig,
          channelConfig,
          provider,
          abort,
          connections,
          statuses,
          reconnects,
          scope,
          attempt: attempt + 1,
        })
      })
    }, delayMs)

    reconnects.set(key, timer)
  }

  async function handleMessage(provider: Provider, ctx: MessageContext, scope: Scope): Promise<void> {
    await Instance.provide({
      scope,
      fn: async () => {
        log.info("message received", {
          channel: ctx.channelType,
          account: ctx.accountId,
          chatId: ctx.chatId,
          from: ctx.senderId,
        })

        Bus.publish(Event.MessageReceived, {
          channelType: ctx.channelType,
          accountId: ctx.accountId,
          chatId: ctx.chatId,
          text: ctx.text,
        })

        const cmdResult = await ChannelCommand.execute(ctx.text, {
          channelType: ctx.channelType,
          accountId: ctx.accountId,
          chatId: ctx.chatId,
          senderId: ctx.senderId,
          senderName: ctx.senderName,
          scopeKey: ctx.scopeKey,
          messageId: ctx.messageId,
          wasMentioned: ctx.wasMentioned,
          mentions: ctx.mentions,
        })

        if (cmdResult.action === "handled") {
          if (cmdResult.reply) {
            await provider.replyMessage({
              accountId: ctx.accountId,
              messageId: ctx.messageId,
              parts: [{ type: "text", text: cmdResult.reply }],
            })
          }
          return
        }

        if (cmdResult.action === "continue") {
          ctx.text = cmdResult.text
        }

        const reactionController = createStatusReactionController({
          adapter: {
            setReaction: async (emoji: string) => {
              const result = await provider.addReaction({
                accountId: ctx.accountId,
                messageId: ctx.messageId,
                emoji,
              })
              return result?.reactionId
            },
            removeReaction: provider.removeReaction
              ? async (reactionId: string) => {
                  await provider.removeReaction?.({
                    accountId: ctx.accountId,
                    messageId: ctx.messageId,
                    reactionId,
                  })
                }
              : undefined,
          },
          onError: (error: unknown) => log.warn("failed to update status reaction", { error }),
        })
        void reactionController.setQueued()

        const streaming = provider.createStreamingSession({
          accountId: ctx.accountId,
          chatId: ctx.chatId,
          replyToMessageId: ctx.messageId,
        })

        const endpoint = SessionEndpoint.fromChannel({
          type: ctx.channelType,
          accountId: ctx.accountId,
          chatId: ctx.chatId,
          chatType: ctx.chatType,
          senderId: ctx.senderId,
          senderName: ctx.senderName,
          scopeKey: ctx.scopeKey,
          createdAt: Date.now(),
        })
        const [session] = await Promise.all([
          Session.getOrCreateForEndpoint(
            endpoint,
            undefined,
            SessionInteraction.unattended(`channel:${ctx.channelType}`),
          ),
          streaming.start(),
        ])
        const sessionID = session.id

        let activeTextMessageId: string | null = null
        const assistantTranscript = new Map<string, string>()
        const messageRoles = new Map<string, MessageV2.Info["role"]>()
        const toolProgress = new Map<
          string,
          StreamingSession["updateToolProgress"] extends (progress: infer P) => Promise<void>
            ? P extends Array<infer Item>
              ? Item
              : never
            : never
        >()

        const unsubMessage = Bus.subscribe(MessageV2.Event.Updated, (event) => {
          if (event.properties.info.sessionID !== sessionID) return
          messageRoles.set(event.properties.info.id, event.properties.info.role)
        })

        const pushToolProgress = async () => {
          const progress = Array.from(toolProgress.values())
          log.info("tool progress pushed", {
            sessionID,
            count: progress.length,
            items: progress.map((item) => ({
              tool: item.tool,
              status: item.status,
              title: item.title,
            })),
          })
          await streaming
            .updateToolProgress(progress)
            .catch((err) => log.warn("tool progress update failed", { error: err }))
        }

        const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
          const part = event.properties.part
          if (part.sessionID !== sessionID) return

          const role = messageRoles.get(part.messageID)
          if (role !== "assistant") return

          if (part.type === "text") {
            if (part.ignored || part.synthetic || !part.text.trim()) return
            if (activeTextMessageId !== part.messageID) {
              activeTextMessageId = part.messageID
            }

            assistantTranscript.set(part.messageID, part.text)
            const transcriptText = buildAssistantTranscript(assistantTranscript)
            await streaming.update(transcriptText).catch((err) => log.warn("streaming update failed", { error: err }))
            return
          }

          if (part.type !== "tool") return

          toolProgress.set(part.id, {
            id: part.id,
            tool: part.tool,
            title: "title" in part.state ? part.state.title : undefined,
            status: part.state.status,
          })
          if (part.state.status === "running") {
            void reactionController.setTool(part.tool)
          }
          await pushToolProgress()
        })

        try {
          const result = await SessionInvoke.invoke({
            sessionID,
            parts: buildPromptParts(ctx),
          })

          const responseText = buildAssistantTranscript(assistantTranscript) || extractResponseText(result.parts)
          await streaming.close(responseText)

          await reactionController.setDone()
        } catch (err) {
          log.error("prompt failed", { sessionID, error: err })
          void reactionController.setError()
          const errorText = buildAssistantTranscript(assistantTranscript) || undefined
          await streaming.close(errorText).catch(() => {})
        } finally {
          unsubMessage()
          unsubPart()
          cleanupAttachments(ctx.attachments)
        }
      },
    })
  }

  function buildPromptParts(ctx: MessageContext): InvokeInput["parts"] {
    const parts: InvokeInput["parts"] = []

    let textBody = ctx.text
    if (ctx.quotedContent) {
      textBody = `[Replying to: "${ctx.quotedContent}"]\n\n${textBody}`
    }
    if (ctx.chatType === "group" && ctx.senderName) {
      textBody = `${ctx.senderName}: ${textBody}`
    }
    parts.push({ type: "text", text: textBody })

    if (ctx.attachments && ctx.attachments.length > 0) {
      for (const attachment of ctx.attachments) {
        parts.push({
          type: "file",
          url: `file://${attachment.path}`,
          filename: attachment.filename ?? attachment.path.split("/").pop() ?? "attachment",
          mime: attachment.contentType,
        })
      }
    }

    return parts
  }

  function buildAssistantTranscript(parts: ReadonlyMap<string, string>): string {
    return Array.from(parts.values())
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  function extractResponseText(parts: MessageV2.Part[]): string {
    return parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .filter((p) => !p.ignored && !p.synthetic && p.text.trim().length > 0)
      .map((p) => p.text)
      .join("\n")
  }

  function cleanupAttachments(attachments?: Attachment[]) {
    if (!attachments) return
    for (const attachment of attachments) {
      fs.unlink(attachment.path).catch(() => {})
    }
  }

  export async function status(): Promise<Record<string, Status>> {
    const s = await state()
    const result: Record<string, Status> = {}
    for (const [key, status] of s.statuses) {
      result[key] = status
    }
    return result
  }

  export async function disconnect(channelType: string, accountId: string): Promise<void> {
    const s = await state()
    const key = connectionKey(channelType, accountId)
    const reconnectTimer = s.reconnects.get(key)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      s.reconnects.delete(key)
    }
    const conn = s.connections.get(key)
    if (conn) {
      conn.abort.abort()
      s.connections.delete(key)
      s.statuses.set(key, { status: "disconnected" })
      Bus.publish(Event.Disconnected, { channelType, accountId })
    }
  }

  export async function disconnectAll(): Promise<void> {
    const s = await state()
    for (const [key, conn] of s.connections) {
      const reconnectTimer = s.reconnects.get(key)
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        s.reconnects.delete(key)
      }
      conn.abort.abort()
      s.statuses.set(key, { status: "disconnected" })
      Bus.publish(Event.Disconnected, {
        channelType: conn.channelType,
        accountId: conn.accountId,
      })
    }
    s.connections.clear()
  }

  export async function start(channelType: string, accountId: string): Promise<void> {
    const s = await state()
    const key = connectionKey(channelType, accountId)

    // Disconnect existing connection first
    const existing = s.connections.get(key)
    if (existing) {
      existing.abort.abort()
      s.connections.delete(key)
    }
    const reconnectTimer = s.reconnects.get(key)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      s.reconnects.delete(key)
    }

    // Resolve config for this specific account
    const cfg = await Config.get()
    const channels = cfg.channel ?? {}
    const channelConfig = channels[channelType]
    if (!channelConfig) {
      throw new StartError({
        message: `Channel type not configured: ${channelType}`,
        channelType,
        accountId,
      })
    }

    const accounts = "accounts" in channelConfig ? channelConfig.accounts : {}
    const accountConfig = accounts[accountId]
    if (!accountConfig) {
      throw new StartError({
        message: `Account not configured: ${channelType}:${accountId}`,
        channelType,
        accountId,
      })
    }

    if ("enabled" in accountConfig && accountConfig.enabled === false) {
      s.statuses.set(key, { status: "disabled" })
      return
    }

    const provider = providers.get(channelType)
    if (!provider) {
      throw new StartError({
        message: `Unknown channel provider: ${channelType}`,
        channelType,
        accountId,
      })
    }

    s.statuses.set(key, { status: "connecting" })
    const abort = new AbortController()
    const scope = Scope.global()

    await connectAccount({
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      abort,
      connections: s.connections,
      statuses: s.statuses,
      reconnects: s.reconnects,
      scope,
    })
  }

  export async function init(): Promise<void> {
    await state()
  }
}
