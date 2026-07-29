import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Scope } from "@/scope"
import { Global } from "@/global"

import { Config } from "../config/config"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInvoke, InvokeInput } from "../session/invoke"

import { Question } from "../question"
import { ChannelCommand } from "./command"
import { resolveChannelAccountInvocation } from "./model-selection"
import { createStatusReactionController } from "./status-reactions"
import { buildAssistantTranscript, resolveFinalResponseText } from "./response-text"
import { loadChannelTaskMessages, replyChannelTaskAttachments } from "./outbound-parts"
import { ResponseCardRuntime } from "./response-card"
import { QuestionCardRuntime } from "./question-card"
import { ChannelInteraction } from "./interaction"
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
  StreamingToolProgress as StreamingToolProgressType,
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

  export async function resolveAccountScope(input: {
    channelType: string
    accountId: string
    accountConfig: unknown
  }): Promise<Scope> {
    const parsed = z
      .object({ projectDir: z.string().trim().min(1).optional() })
      .passthrough()
      .safeParse(input.accountConfig)
    const projectDir = parsed.success ? parsed.data.projectDir : undefined
    if (!projectDir) return Scope.home()

    const resolved = path.resolve(Global.Path.home, projectDir)
    try {
      const stat = await fs.stat(resolved)
      if (!stat.isDirectory()) throw new Error("not a directory")
      await fs.access(resolved, fs.constants.R_OK | fs.constants.X_OK)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === "ENOENT" ? "CHANNEL_PROJECT_DIR_NOT_FOUND" : "CHANNEL_PROJECT_DIR_NOT_READABLE"
      throw new StartError({
        message: `${reason}: ${input.channelType} account "${input.accountId}" projectDir "${projectDir}" is unavailable`,
        channelType: input.channelType,
        accountId: input.accountId,
      })
    }

    const { scope } = await Scope.fromDirectory(resolved)
    if (scope.type !== "project") {
      throw new StartError({
        message: `CHANNEL_PROJECT_DIR_NOT_A_PROJECT: ${input.channelType} account "${input.accountId}" projectDir "${projectDir}" did not resolve to a project Scope`,
        channelType: input.channelType,
        accountId: input.accountId,
      })
    }
    log.info("channel account bound to project scope", {
      channelType: input.channelType,
      accountId: input.accountId,
      projectDir: resolved,
      scopeID: scope.id,
    })
    return scope
  }

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

  const state = ScopedState.create(
    async (): Promise<State> => {
      const cfg = await Config.current()
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

  export async function stopAll() {
    await state.resetAll()
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
      attempt = 0,
    } = input
    const key = connectionKey(channelType, accountId)
    const scope = await resolveAccountScope({ channelType, accountId, accountConfig })

    const reconnectTimer = reconnects.get(key)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnects.delete(key)
    }

    await provider.connect({
      accountId,
      accountConfig,
      channelConfig,
      onMessage: (ctx) => handleMessage(provider, ctx, scope, accountConfig),
      onResponseCardAction: (callback) =>
        ScopeContext.provide({
          scope,
          fn: () =>
            ResponseCardRuntime.acceptAction({
              channelType,
              accountId,
              callback,
            }),
        }),
      onQuestionCardAction: (callback) =>
        ScopeContext.provide({
          scope,
          fn: () =>
            QuestionCardRuntime.acceptAction({
              channelType,
              accountId,
              callback,
            }),
        }),
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
          attempt: attempt + 1,
        })
      })
    }, delayMs)

    reconnects.set(key, timer)
  }

  async function handleMessage(
    provider: Provider,
    ctx: MessageContext,
    scope: Scope,
    accountConfig: unknown,
  ): Promise<void> {
    try {
      await ScopeContext.provide({
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
            chatType: ctx.chatType,
            chatName: ctx.chatName,
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
            chatName: ctx.chatName,
            senderId: ctx.senderId,
            senderName: ctx.senderName,
            scopeKey: ctx.scopeKey,
            createdAt: Date.now(),
          })
          const session = await Session.getOrCreateForEndpoint(
            endpoint,
            undefined,
            ChannelInteraction.forType(ctx.channelType),
          )
          await streaming.start()
          const sessionID = session.id
          const accountInvocation = resolveChannelAccountInvocation({
            accountConfig,
            sessionModelOverride: session.modelOverride,
          })

          const assistantTranscript = new Map<string, string>()
          const messageRoles = new Map<string, MessageV2.Info["role"]>()
          const toolProgress = new Map<string, StreamingToolProgressType>()

          const settleQuestionCard = (event: { properties: { sessionID: string; requestID: string } }) => {
            if (event.properties.sessionID !== sessionID) return
            void QuestionCardRuntime.settle(event.properties.requestID).catch((error) =>
              log.warn("question card settlement failed", {
                sessionID,
                requestID: event.properties.requestID,
                error,
              }),
            )
          }
          const unsubQuestionAsked = Bus.subscribe(Question.Event.Asked, (event) => {
            if (event.properties.sessionID !== sessionID) return
            void QuestionCardRuntime.deliver({
              provider,
              accountId: ctx.accountId,
              chatId: ctx.chatId,
              replyToMessageId: ctx.rootId ?? ctx.messageId,
              requesterId: ctx.senderId,
              sessionID,
              request: event.properties,
            })
          })
          const unsubQuestionReplied = Bus.subscribe(Question.Event.Replied, settleQuestionCard)
          const unsubQuestionRejected = Bus.subscribe(Question.Event.Rejected, settleQuestionCard)
          const unsubQuestionTimedOut = Bus.subscribe(Question.Event.TimedOut, settleQuestionCard)
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
              if (MessageV2.isSystemPart(part) || !part.text.trim()) return

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
              ...accountInvocation,
              metadata: {
                channelReplyToMessageId: ctx.rootId ?? ctx.messageId,
                channelRequesterId: ctx.senderId,
              },
              parts: buildPromptParts(ctx),
            })

            const responseText = resolveFinalResponseText(assistantTranscript, result.parts)
            const hasError = result.info.role === "assistant" && "error" in result.info && result.info.error != null

            // If the response failed but tools completed successfully, build a
            // degraded fallback so the user still receives tool outputs.
            const fallbackText = hasError ? buildDegradedFallback(toolProgress) : undefined
            await streaming.close(responseText || fallbackText, hasError)
            const rootID =
              result.info.role === "assistant" ? (result.info.rootID ?? result.info.parentID) : result.info.id
            const taskMessages = await loadChannelTaskMessages({ sessionID, rootID, terminal: result })
            await ResponseCardRuntime.deliverTaskCards({
              provider,
              accountId: ctx.accountId,
              chatId: ctx.chatId,
              replyToMessageId: ctx.rootId ?? ctx.messageId,
              sessionID,
              terminal: result,
              messages: taskMessages,
            }).catch((err) => log.warn("response card delivery failed", { sessionID, error: err }))
            await replyChannelTaskAttachments({
              provider,
              accountId: ctx.accountId,
              messageId: ctx.rootId ?? ctx.messageId,
              sessionID,
              terminal: result,
              messages: taskMessages,
            }).catch((err) => log.warn("channel task attachments delivery failed", { sessionID, error: err }))
            await reactionController.setDone()
          } catch (err) {
            log.error("prompt failed", { sessionID, error: err })
            void reactionController.setError()
            const errorText = buildAssistantTranscript(assistantTranscript) || undefined
            await streaming
              .close(errorText, true)
              .catch((closeError) =>
                log.warn("streaming card error finalization failed", { sessionID, error: closeError }),
              )
          } finally {
            unsubMessage()
            unsubPart()
            unsubQuestionAsked()
            unsubQuestionReplied()
            unsubQuestionRejected()
            unsubQuestionTimedOut()
            await QuestionCardRuntime.clearSession(sessionID)
          }
        },
      })
    } finally {
      await cleanupAttachments(ctx.attachments)
    }
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
          type: "attachment",
          url: pathToFileURL(attachment.path).href,
          filename: attachment.filename ?? path.basename(attachment.path) ?? "attachment",
          mime: attachment.contentType,
          model: attachment.contentType.startsWith("image/")
            ? {
                mode: "provider-file",
                summary: `${attachment.filename ?? path.basename(attachment.path) ?? "attachment"} (${attachment.contentType})`,
              }
            : {
                mode: "summary",
                summary: `${attachment.filename ?? path.basename(attachment.path) ?? "attachment"} (${attachment.contentType})`,
              },
        })
      }
    }

    return parts
  }

  async function cleanupAttachments(attachments?: Attachment[]) {
    await Promise.all(attachments?.map((attachment) => fs.unlink(attachment.path).catch(() => {})) ?? [])
  }

  /**
   * Build a minimal degraded fallback message when the main LLM response failed
   * (e.g. content-filtered) but tools completed successfully. This ensures the
   * user still receives file paths, links, or other critical tool outputs.
   */
  function buildDegradedFallback(
    toolProgress: ReadonlyMap<string, { status: string; title?: string; tool: string }>,
  ): string | undefined {
    const completedTools = Array.from(toolProgress.values()).filter((t) => t.status === "completed")
    if (completedTools.length === 0) return undefined

    const lines = ["⚠️ Response generation failed, but these tools completed successfully:"]
    for (const tool of completedTools) {
      const title = tool.title ?? tool.tool
      lines.push(`- ${title}`)
    }
    lines.push("\nReview the tool outputs above or try again later.")
    return lines.join("\n")
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
    const cfg = await Config.current()
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
    })
  }

  export async function init(): Promise<void> {
    await state()
  }
}
