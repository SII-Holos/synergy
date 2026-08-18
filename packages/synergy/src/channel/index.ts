import fs from "fs/promises"
import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Scope } from "@/scope"
import { ScopeRuntime } from "@/scope/runtime"
import { Global } from "@/global"

import { Config } from "../config/config"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInteraction } from "../session/interaction"
import { SessionInvoke } from "../session/invoke"

import { ChannelCommand } from "./command"
import {
  resolveChannelAccountInvocation,
  resolveChannelAccountAgent,
  resolveChannelInvocationWithImages,
} from "./model-selection"
import { createStatusReactionController } from "./status-reactions"
import { buildAssistantTranscript, resolveFinalResponseText } from "./response-text"
import { ManagedProjectOwnership } from "./managed-project-ownership"
import { externalIdentityHash } from "./identity"
import { ChannelHost } from "./host"
import {
  recording as recordDiagnostic,
  list as listDiagnostics,
  iterate as iterateDiagnostics,
  DiagnosticRecord,
} from "./diagnostics"
import { loadChannelTaskMessages, replyChannelTaskAttachments } from "./outbound-parts"
import { ResponseCardRuntime } from "./response-card"
import { QuestionCardRuntime } from "./question-card"
import { QuestionCardBridge } from "./question-card-bridge"
import { ChannelInteraction } from "./interaction"
import { ChannelOutbound } from "./outbound"
import { ChannelBusyHandoff } from "./busy-handoff"
import { ChannelConversationAcceptance } from "./conversation-acceptance"
import {
  Info as InfoSchema,
  Status as StatusSchema,
  Mention as MentionSchema,
  Attachment as AttachmentSchema,
  MessageContext as MessageContextSchema,
} from "./types"
import type {
  Info as InfoType,
  Status as StatusType,
  Mention as MentionType,
  Attachment as AttachmentType,
  MessageContext as MessageContextType,
  ConversationCapabilities as ConversationCapabilitiesType,
  SendResult as SendResultType,
  StreamingSession as StreamingSessionType,
  Provider as ProviderType,
} from "./types"

export namespace Channel {
  const log = Log.create({ service: "channel" })
  const RECONNECT_DELAY_MS = 2_000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const MAX_RECONNECT_ATTEMPTS = 50

  /** Runtime Boss Mode normalized scopeKey for Feishu routing (see BossRuntime.BOSS_SCOPE_KEY). */
  const BOSS_ROUTE_SCOPE_KEY = "boss"

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
  export type ConversationCapabilities = ConversationCapabilitiesType
  export type SendResult = SendResultType
  export type StreamingSession = StreamingSessionType
  export type Provider<TAccountConfig = unknown, TChannelConfig = unknown> = ProviderType<
    TAccountConfig,
    TChannelConfig
  >

  export async function findProjectScope(input: {
    channelType: string
    accountId: string
    externalProjectId: string
  }): Promise<Scope.Project | undefined> {
    const record = await ManagedProjectOwnership.find({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    if (!record) return undefined
    const scope = await Scope.fromID(record.scopeID)
    if (scope?.type !== "project") return undefined
    return scope
  }

  export async function ensureProjectScope(input: {
    channelType: string
    accountId: string
    externalProjectId: string
    projectName?: string
  }): Promise<Scope.Project> {
    const record = await ManagedProjectOwnership.ensure({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
      projectName: input.projectName,
      remoteState: "active",
    })
    const scope = await Scope.fromID(record.scopeID)
    if (!scope || scope.type !== "project") throw new Error("Channel managed project ownership Scope not found")
    return scope
  }

  export async function archiveProjectScope(input: {
    channelType: string
    accountId: string
    externalProjectId: string
  }): Promise<void> {
    await ManagedProjectOwnership.markArchived({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
  }

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
  }

  type Connection = {
    channelType: string
    accountId: string
    provider: Provider
    scope: Scope
    abort: AbortController
    status: Status
    stopping?: Promise<void>
  }
  type ConnectionAttempt = {
    abort: AbortController
    stopping?: Promise<void>
    disconnect?: () => Promise<void>
  }
  type ProjectRefresh = {
    connection: Connection
    promise: Promise<void>
  }

  type State = {
    connections: Map<string, Connection>
    statuses: Map<string, Status>
    reconnects: Map<string, ReturnType<typeof setTimeout>>
    attempts: Map<string, ConnectionAttempt>
    unsubscribeScopeRuntimeStarting: () => void
    projectRefreshes: Map<string, ProjectRefresh>
  }

  type ConnectContext = {
    channelType: string
    accountId: string
    accountConfig: unknown
    channelConfig: Config.Channel
    provider: Provider
    attempt: ConnectionAttempt
    connections: Map<string, Connection>
    statuses: Map<string, Status>
    reconnects: Map<string, ReturnType<typeof setTimeout>>
    attempts: Map<string, ConnectionAttempt>
  }

  function connectionKey(channelType: string, accountId: string): string {
    return `${channelType}:${accountId}`
  }

  async function stopConnection(conn: Connection): Promise<void> {
    if (conn.stopping) return conn.stopping
    conn.abort.abort()
    conn.stopping = (async () => {
      try {
        await conn.provider.disconnect?.({ accountId: conn.accountId })
      } catch (error) {
        log.warn("channel provider disconnect failed", {
          channelType: conn.channelType,
          accountId: conn.accountId,
          error,
        })
      }
    })()
    return conn.stopping
  }

  async function stopAttempt(attempt: ConnectionAttempt): Promise<void> {
    if (attempt.stopping) return attempt.stopping
    attempt.abort.abort()
    attempt.stopping = attempt.disconnect?.() ?? Promise.resolve()
    return attempt.stopping
  }

  const providers = new Map<string, Provider>()

  export function registerProvider<TAccountConfig, TChannelConfig>(
    provider: Provider<TAccountConfig, TChannelConfig>,
  ): void {
    providers.set(provider.type, provider as unknown as Provider)
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
      const attempts = new Map<string, ConnectionAttempt>()
      const projectRefreshes = new Map<string, ProjectRefresh>()
      const unsubscribeScopeRuntimeStarting = ScopeRuntime.onStarting((scope) => {
        const ownsScope = Array.from(connections.values()).some((connection) => connection.scope.id === scope.id)
        if (ownsScope) initializeScopeBridges()
      })

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
          const attempt = { abort: new AbortController() }

          connectInBackground({
            channelType,
            accountId,
            accountConfig,
            channelConfig,
            provider,
            attempt,
            connections,
            statuses,
            reconnects,
            attempts,
          })
        }
      }

      return {
        connections,
        statuses,
        reconnects,
        attempts,
        projectRefreshes,
        unsubscribeScopeRuntimeStarting,
      }
    },
    async (s) => {
      s.unsubscribeScopeRuntimeStarting()
      for (const timer of s.reconnects.values()) clearTimeout(timer)
      await Promise.all(Array.from(s.attempts.values(), (attempt) => stopAttempt(attempt)))
      s.attempts.clear()
      await Promise.all(
        Array.from(s.connections.values(), async (conn) => {
          await stopConnection(conn)
          Bus.publish(Event.Disconnected, {
            channelType: conn.channelType,
            accountId: conn.accountId,
            reason: "shutdown",
          })
        }),
      )
      s.connections.clear()
    },
  )

  export async function reload() {
    log.info("reloading channel state")
    await state.resetAll()
    // resetAll() only disposes connections; rebuild them eagerly in the home
    // scope so a reload never leaves channels destroyed-but-not-reconnected.
    // Channels are a global resource: the server starts them under the home
    // scope, so the rebuilt state must land there regardless of the caller's
    // ambient scope, or the next home-scoped access would create a second
    // state and duplicate connections.
    await ScopeContext.provide({ scope: Scope.home(), fn: () => state() })
    log.info("channel state reloaded")
  }

  export async function stopAll() {
    await state.resetAll()
  }

  function initializeScopeBridges() {
    QuestionCardBridge.init()
    ChannelOutbound.init({ getProvider })
  }
  async function connectAccount(input: ConnectContext & { reconnectAttempt?: number }): Promise<void> {
    const {
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      attempt,
      connections,
      statuses,
      reconnects,
      attempts,
    } = input
    const key = connectionKey(channelType, accountId)
    const currentAttempt = attempts.get(key)
    if (attempt.abort.signal.aborted || (currentAttempt && currentAttempt !== attempt)) return
    attempts.set(key, attempt)
    attempt.disconnect = async () => {
      try {
        await provider.disconnect?.({ accountId })
      } catch (error) {
        log.warn("channel provider disconnect failed", {
          channelType,
          accountHash: externalIdentityHash(accountId),
          error,
        })
      }
    }
    const reconnectTimer = reconnects.get(key)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnects.delete(key)
    }

    const scope = await resolveAccountScope({ channelType, accountId, accountConfig })
    await ScopeContext.provide({ scope, fn: initializeScopeBridges })

    if (provider.lifecycle === "borrowed_transport" && provider.waitForTransport) {
      statuses.set(key, { status: "waiting_for_transport" })
      await provider.waitForTransport({ accountId, signal: attempt.abort.signal })
      if (attempt.abort.signal.aborted || attempts.get(key) !== attempt) return
    }
    statuses.set(key, { status: "connecting" })

    const host = ChannelHost.create({
      channelType,
      accountId,
      activateTasks: true,
      onConversationMessage: (ctx) => handleMessage(provider, ctx, scope, accountConfig),
      onDiagnostic: async (record) => {
        await recordDiagnostic(channelType, accountId, record)
      },
    })
    try {
      await provider.connect({
        accountId,
        accountConfig,
        channelConfig,
        signal: attempt.abort.signal,
        host,
        onResponseCardAction: (callback) =>
          ScopeContext.provide({
            scope,
            fn: () => ResponseCardRuntime.acceptAction({ channelType, accountId, callback }),
          }),
        onQuestionCardAction: (callback) =>
          ScopeContext.provide({
            scope,
            fn: () => QuestionCardRuntime.acceptAction({ channelType, accountId, callback }),
          }),
        onDisconnect: (reason) => {
          if (attempt.abort.signal.aborted) return
          const pending = attempts.get(key)
          const active = connections.get(key)
          const isPending = pending === attempt
          const isActive = active?.abort === attempt.abort
          if (!isPending && !isActive) return

          log.info("channel disconnected", { channelType, accountHash: externalIdentityHash(accountId), reason })
          attempt.abort.abort()
          if (isPending) attempts.delete(key)
          if (isActive) {
            connections.delete(key)
            statuses.set(key, { status: "disconnected" })
            Bus.publish(Event.Disconnected, { channelType, accountId, reason })
          }

          if (provider.lifecycle === "borrowed_transport" && provider.waitForTransport) {
            connectInBackground({
              channelType,
              accountId,
              accountConfig,
              channelConfig,
              provider,
              attempt: { abort: new AbortController() },
              connections,
              statuses,
              reconnects,
              attempts,
            })
            return
          }
          scheduleReconnect({
            channelType,
            accountId,
            accountConfig,
            channelConfig,
            provider,
            attempt: { abort: new AbortController() },
            connections,
            statuses,
            reconnects,
            attempts,
            reconnectAttempt: 0,
          })
        },
      })
    } catch (error) {
      if (!attempt.abort.signal.aborted) {
        try {
          await provider.disconnect?.({ accountId })
        } catch (disconnectError) {
          log.warn("channel provider cleanup failed after connection error", {
            channelType,
            accountHash: externalIdentityHash(accountId),
            error: disconnectError,
          })
        }
      }
      throw error
    }
    if (attempt.abort.signal.aborted || attempts.get(key) !== attempt) return

    connections.set(key, {
      channelType,
      accountId,
      provider,
      scope,
      abort: attempt.abort,
      status: { status: "connected" },
    })
    statuses.set(key, { status: "connected" })
    reconnects.delete(key)
    attempts.delete(key)

    log.info("channel connected", { channelType, accountHash: externalIdentityHash(accountId) })
    Bus.publish(Event.Connected, { channelType, accountId })
  }

  function connectInBackground(input: ConnectContext & { reconnectAttempt?: number }): void {
    const key = connectionKey(input.channelType, input.accountId)
    const current = input.attempts.get(key)
    if (current && current !== input.attempt) return
    input.attempts.set(key, input.attempt)
    void connectAccount(input).catch((err) => {
      if (input.attempt.abort.signal.aborted || input.attempts.get(key) !== input.attempt) return
      input.attempts.delete(key)
      const error = err instanceof Error ? err.message : String(err)
      log.error("channel connection failed", {
        channelType: input.channelType,
        accountHash: externalIdentityHash(input.accountId),
        attempt: input.reconnectAttempt ?? 0,
        error,
      })
      input.statuses.set(key, { status: "failed", error })
      scheduleReconnect({
        ...input,
        reconnectAttempt: input.reconnectAttempt ?? 0,
        retryBorrowedInitialization: true,
      })
    })
  }

  function scheduleReconnect(
    input: ConnectContext & { reconnectAttempt: number; retryBorrowedInitialization?: boolean },
  ): void {
    const {
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      attempt,
      connections,
      statuses,
      reconnects,
      attempts,
      reconnectAttempt,
    } = input
    if (attempt.abort.signal.aborted) return
    if (provider.lifecycle !== "self_connected" && !input.retryBorrowedInitialization) return

    const key = connectionKey(channelType, accountId)

    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log.warn("max reconnect attempts exceeded", {
        channelType,
        accountHash: externalIdentityHash(accountId),
        attempt: reconnectAttempt,
      })
      statuses.set(key, { status: "failed", error: "max reconnect attempts exceeded" })
      return
    }

    const existingTimer = reconnects.get(key)
    if (existingTimer) clearTimeout(existingTimer)

    const delayMs = Math.min(RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS)
    statuses.set(key, { status: "connecting" })

    const timer = setTimeout(() => {
      reconnects.delete(key)
      if (attempt.abort.signal.aborted) return

      connectInBackground({
        channelType,
        accountId,
        accountConfig,
        channelConfig,
        provider,
        attempt,
        connections,
        statuses,
        reconnects,
        attempts,
        reconnectAttempt: reconnectAttempt + 1,
      })
    }, delayMs)

    reconnects.set(key, timer)
  }

  async function handleMessage(
    provider: Provider,
    ctx: MessageContext,
    scope: Scope,
    accountConfig: unknown,
  ): Promise<ChannelHost.ReceiveResult> {
    const conversation = provider.conversation ?? provider
    const replyMessage = conversation.replyMessage?.bind(conversation)
    const addReaction = conversation.addReaction?.bind(conversation)
    const removeReaction = conversation.removeReaction?.bind(conversation)
    const createStreamingSession = conversation.createStreamingSession?.bind(conversation)

    // Providers may resolve a per-message Scope (e.g. a dedicated checkout
    // directory for a GitHub pull request thread). The account-level Scope
    // stays the fallback.
    const conversationScope =
      (await provider.resolveConversationScope?.({
        accountId: ctx.accountId,
        accountConfig,
        message: ctx,
      })) ?? scope

    // --- Acceptance phase (awaited by the provider lane) ---
    return ScopeContext.provide({
      scope: conversationScope,
      fn: async () => {
        try {
          if (!replyMessage || !addReaction || !createStreamingSession) {
            log.warn("channel provider is missing conversation capabilities", { channelType: provider.type })
            return { accepted: false, reason: "rejected" }
          }
          log.info("message received", {
            channel: ctx.channelType,
            accountHash: externalIdentityHash(ctx.accountId),
            chatHash: externalIdentityHash(ctx.chatId),
            senderHash: externalIdentityHash(ctx.senderId),
          })

          const cmdResult = await ChannelCommand.execute(
            ctx.commandText ?? ctx.text,
            {
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
            },
            conversationScope,
          )

          if (cmdResult.action === "handled") {
            if (cmdResult.reply) {
              await replyMessage({
                accountId: ctx.accountId,
                messageId: ctx.messageId,
                chatId: ctx.chatId,
                chatType: ctx.chatType,
                scopeKey: ctx.scopeKey,
                parts: [{ type: "text", text: cmdResult.reply }],
              })
            }
            return { accepted: false, reason: "command" as const }
          }

          if (cmdResult.action === "continue") {
            ctx.text = cmdResult.text
          }

          // Runtime Boss Mode routing: when enabled for this Feishu account,
          // all accepted messages (group + DM) are routed to the account's
          // runtime boss session by normalizing the scopeKey, and the reply is
          // anchored to the original message so the outbound bridge never
          // misroutes across chats. A source header is prepended so the boss
          // can attribute the message (group, sender, time).
          const bossSessionID = await resolveBossRoutingSession(ctx)
          if (bossSessionID) {
            ctx.scopeKey = BOSS_ROUTE_SCOPE_KEY
            ctx.replyToMessageId = ctx.messageId
            const senderLabel = ctx.senderName?.trim() || ctx.senderId
            const chatLabel = ctx.chatName?.trim() || ctx.chatId
            const timeLabel = new Date(ctx.timestamp).toLocaleString("zh-CN", { hour12: false })
            const header = `[群: ${chatLabel} | 发送者: ${senderLabel} | ${timeLabel}]`
            if (!ctx.text.startsWith(header)) {
              ctx.text = `${header}\n\n${ctx.text}`
            }
          }
          // Resolve the reply anchor after boss routing so the forced
          // `ctx.replyToMessageId = ctx.messageId` (boss mode) is honored.
          const replyToMessageId = ctx.replyToMessageId ?? ctx.rootId ?? ctx.messageId

          const endpoint = SessionEndpoint.fromChannel({
            type: ctx.channelType,
            accountId: ctx.accountId,
            chatId: ctx.chatId,
            chatType: ctx.chatType,
            // Boss-routed messages share one aggregated session: the boss
            // session's display chatName must not flap to whichever chat
            // messaged last, so keep the provisioned name ("Runtime Boss").
            chatName: bossSessionID ? undefined : ctx.chatName,
            senderId: ctx.senderId,
            senderName: ctx.senderName,
            scopeKey: ctx.scopeKey,
            createdAt: Date.now(),
          })
          const session = await Session.getOrCreateForEndpoint(endpoint, {
            scope: conversationScope,
            // Boss-routed messages must not rewrite the runtime boss session's
            // interaction (source "boss") into a plain channel interaction.
            interaction: bossSessionID
              ? SessionInteraction.interactive("boss")
              : ChannelInteraction.forType(ctx.channelType),
            ...(provider.defaultAgent
              ? { agentOverride: resolveChannelAccountAgent(accountConfig) ?? provider.defaultAgent }
              : {}),
          })
          const sessionID = session.id
          const hasImageAttachments = (ctx.attachments ?? []).some((attachment) =>
            attachment.contentType.startsWith("image/"),
          )
          const accountInvocation = await resolveChannelInvocationWithImages({
            invocation: resolveChannelAccountInvocation({
              accountConfig,
              sessionModelOverride: session.modelOverride,
            }),
            hasImageAttachments,
          })
          const deliveryKey = ChannelBusyHandoff.deliveryKeyForMessage({
            channelType: ctx.channelType,
            accountId: ctx.accountId,
            messageId: ctx.messageId,
          })
          const metadata = {
            channelReply: true,
            channelReplyToMessageId: replyToMessageId,
            channelRequesterId: ctx.senderId,
            channelChatId: ctx.chatId,
            channelChatName: ctx.chatName,
            channelSenderId: ctx.senderId,
            channelSenderName: ctx.senderName,
          }

          const acceptance = await ChannelConversationAcceptance.accept({
            sessionID,
            deliveryKey,
            prepareParts: (messageID) => buildPromptParts(ctx, { sessionID, messageID }),
            metadata,
            model: accountInvocation.model,
            variant: accountInvocation.variant,
            execute: async (lease, delivery) => {
              const reactionController = createStatusReactionController({
                adapter: {
                  setReaction: async (emoji: string) => {
                    const result = await addReaction({
                      accountId: ctx.accountId,
                      messageId: ctx.messageId,
                      emoji,
                    })
                    return result?.reactionId
                  },
                  removeReaction: removeReaction
                    ? async (reactionId: string) => {
                        await removeReaction({
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

              let streaming = createStreamingSession({
                accountId: ctx.accountId,
                chatId: ctx.chatId,
                chatType: ctx.chatType,
                replyToMessageId,
                sessionID,
                scopeKey: ctx.scopeKey,
              })
              try {
                await streaming.start()
              } catch (error) {
                log.warn("streaming session startup failed; using text fallback", { sessionID, error })
                streaming = createTextFallbackSession({
                  replyMessage,
                  accountId: ctx.accountId,
                  chatId: ctx.chatId,
                  chatType: ctx.chatType,
                  messageId: replyToMessageId,
                  scopeKey: ctx.scopeKey,
                })
              }

              // A foreground streaming session that owns the terminal delivery
              // (e.g. Feishu cards post the final text in close()) must not be
              // re-delivered by the outbound bridge: register the root so the
              // bridge skips it. Sessions that do not own delivery (e.g.
              // GitHub, whose streaming session is a no-op and relies on the
              // bridge for comments) are never registered, so the bridge
              // posts the reply. Queued (busy/recovered) roots are never
              // registered and keep the bridge as their delivery path.
              const ownsTerminalDelivery = streaming.ownsTerminalDelivery?.() === true
              if (ownsTerminalDelivery) {
                ChannelOutbound.beginForeground(sessionID, delivery.messageID)
              }

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
                  if (MessageV2.isSystemPart(part) || !part.text.trim()) return

                  assistantTranscript.set(part.messageID, part.text)
                  const transcriptText = buildAssistantTranscript(assistantTranscript)
                  await streaming
                    .update(transcriptText)
                    .catch((err) => log.warn("streaming update failed", { error: err }))
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
                const result = await SessionInvoke.invokeInboxWithLease(
                  {
                    sessionID,
                    itemID: delivery.itemID,
                  },
                  lease,
                )

                const responseText = resolveFinalResponseText(assistantTranscript, result.parts)
                const hasError = result.info.role === "assistant" && "error" in result.info && result.info.error != null

                // If the response failed but tools completed successfully, build a
                // degraded fallback so the user still receives tool outputs.
                const fallbackText = hasError ? buildDegradedFallback(toolProgress) : undefined
                await streaming.close(responseText || fallbackText, hasError)
                if (result.info.role === "assistant" && ownsTerminalDelivery) {
                  // The streaming session already delivered this root's terminal
                  // reply. Persist the sent marker so any later message update
                  // (context usage, metadata merge) never re-triggers the
                  // outbound bridge after the foreground registration ends.
                  await Session.mergeMessageMetadata({
                    sessionID,
                    messageID: result.info.id,
                    metadata: { channelOutboundSent: true },
                  }).catch((err) => log.warn("failed to mark channel reply as sent", { sessionID, error: err }))
                }
                const rootID =
                  result.info.role === "assistant" ? (result.info.rootID ?? result.info.parentID) : result.info.id
                const taskMessages = await loadChannelTaskMessages({ sessionID, rootID, terminal: result })
                await ResponseCardRuntime.deliverTaskCards({
                  provider,
                  accountId: ctx.accountId,
                  chatId: ctx.chatId,
                  chatType: ctx.chatType,
                  scopeKey: ctx.scopeKey,
                  replyToMessageId,
                  sessionID,
                  terminal: result,
                  messages: taskMessages,
                }).catch((err) => log.warn("response card delivery failed", { sessionID, error: err }))
                await replyChannelTaskAttachments({
                  provider,
                  accountId: ctx.accountId,
                  messageId: replyToMessageId,
                  sessionID,
                  terminal: result,
                  messages: taskMessages,
                }).catch((err) => log.warn("channel task attachments delivery failed", { sessionID, error: err }))
                await reactionController.setDone()
              } catch (err) {
                // A busy Session must not surface a generation failure: persist the
                // message as a durable inbox task with stable delivery identity so
                // the existing ChannelOutbound reply path can deliver it later.
                const queued = await ChannelBusyHandoff.deliverBusyTaskToInbox({
                  error: err,
                  sessionID,
                  deliveryKey,
                  parts: delivery.parts,
                  metadata,
                  model: accountInvocation.model,
                  variant: accountInvocation.variant,
                })
                if (queued.status !== "not-busy") {
                  log.info("busy session message queued to inbox", {
                    sessionID,
                    itemID: queued.status === "queued" ? queued.itemID : undefined,
                    duplicate: queued.status === "duplicate",
                  })
                  // Close the queued card cleanly without pretending the generation
                  // failed; the delayed final reply is delivered by ChannelOutbound.
                  await streaming
                    .close(undefined, false)
                    .catch((closeError) =>
                      log.warn("streaming card queued finalization failed", { sessionID, error: closeError }),
                    )
                  return
                }
                log.error("prompt failed", { sessionID, error: err })
                void reactionController.setError()
                const errorText = buildAssistantTranscript(assistantTranscript) || undefined
                await streaming
                  .close(errorText, true)
                  .catch((closeError) =>
                    log.warn("streaming card error finalization failed", { sessionID, error: closeError }),
                  )
              } finally {
                ChannelOutbound.endForeground(sessionID, delivery.messageID)
                unsubMessage()
                unsubPart()
              }
            },
          })

          if (!acceptance.accepted) {
            return { accepted: false, reason: "rejected" }
          }
          return { accepted: true, execution: acceptance.execution }
        } finally {
          await cleanupAttachments(ctx.attachments)
        }
      },
    })
  }

  function createTextFallbackSession(input: {
    replyMessage: NonNullable<ConversationCapabilities["replyMessage"]>
    accountId: string
    messageId: string
    chatId: string
    chatType: "dm" | "group"
    scopeKey?: string
  }): StreamingSession {
    return {
      async start() {},
      async update() {},
      async updateToolProgress() {},
      async close(finalText) {
        if (!finalText?.trim()) return
        await input.replyMessage({
          accountId: input.accountId,
          messageId: input.messageId,
          chatId: input.chatId,
          chatType: input.chatType,
          scopeKey: input.scopeKey,
          parts: [{ type: "text", text: finalText }],
        })
      },
      isActive: () => false,
      ownsTerminalDelivery: () => true,
    }
  }

  function buildPromptParts(ctx: MessageContext, input: { sessionID: string; messageID?: string }) {
    return ChannelBusyHandoff.buildDurablePromptParts({
      ctx,
      sessionID: input.sessionID,
      messageID: input.messageID ?? "",
    })
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
      s.statuses.set(key, { status: "disconnected" })
    }
    const attempt = s.attempts.get(key)
    if (attempt) {
      await stopAttempt(attempt)
      s.attempts.delete(key)
      s.statuses.set(key, { status: "disconnected" })
    }
    const conn = s.connections.get(key)
    if (!conn) return

    await stopConnection(conn)
    if (s.connections.get(key) === conn) s.connections.delete(key)
    s.statuses.set(key, { status: "disconnected" })
    Bus.publish(Event.Disconnected, { channelType, accountId })
  }

  export async function disconnectAll(): Promise<void> {
    const s = await state()
    for (const [key, timer] of s.reconnects) {
      clearTimeout(timer)
      s.statuses.set(key, { status: "disconnected" })
    }
    s.reconnects.clear()
    await Promise.all(
      Array.from(s.attempts.entries(), async ([key, attempt]) => {
        await stopAttempt(attempt)
        s.statuses.set(key, { status: "disconnected" })
      }),
    )
    s.attempts.clear()
    await Promise.all(
      Array.from(s.connections.entries(), async ([key, conn]) => {
        await stopConnection(conn)
        if (s.connections.get(key) === conn) s.connections.delete(key)
        s.statuses.set(key, { status: "disconnected" })
        Bus.publish(Event.Disconnected, {
          channelType: conn.channelType,
          accountId: conn.accountId,
        })
      }),
    )
  }

  export async function start(channelType: string, accountId: string): Promise<void> {
    const s = await state()
    const key = connectionKey(channelType, accountId)

    const existing = s.connections.get(key)
    if (existing) {
      await stopConnection(existing)
      if (s.connections.get(key) === existing) s.connections.delete(key)
    }
    const activeAttempt = s.attempts.get(key)
    if (activeAttempt) {
      await stopAttempt(activeAttempt)
      s.attempts.delete(key)
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
    const attempt = { abort: new AbortController() }

    const context = {
      channelType,
      accountId,
      accountConfig,
      channelConfig,
      provider,
      attempt,
      connections: s.connections,
      statuses: s.statuses,
      reconnects: s.reconnects,
      attempts: s.attempts,
    }
    if (provider.lifecycle === "borrowed_transport" && provider.waitForTransport) {
      connectInBackground(context)
      return
    }
    await connectAccount(context)
  }

  export const RefreshError = NamedError.create(
    "ChannelRefreshError",
    z.object({
      message: z.string(),
      channelType: z.string(),
      accountId: z.string(),
    }),
  )

  export const RefreshUnavailableError = NamedError.create(
    "ChannelRefreshUnavailable",
    z.object({
      message: z.string(),
      channelType: z.string(),
      accountId: z.string(),
      currentStatus: Status,
      retryable: z.literal(true),
    }),
  )

  export async function refreshProjects(channelType: string, accountId: string): Promise<void> {
    const s = await state()
    const key = connectionKey(channelType, accountId)
    const conn = s.connections.get(key)
    if (!conn) {
      const currentStatus = s.statuses.get(key)
      if (currentStatus?.status === "waiting_for_transport" || currentStatus?.status === "connecting") {
        throw new RefreshUnavailableError({
          message: `Channel account refresh is not available while the account is ${currentStatus.status}`,
          channelType,
          accountId,
          currentStatus,
          retryable: true,
        })
      }
      throw new RefreshError({
        message: "Channel account is not connected",
        channelType,
        accountId,
      })
    }
    if (!conn.provider.refreshProjects) {
      throw new RefreshError({
        message: "Channel provider does not support project refresh",
        channelType,
        accountId,
      })
    }
    const existing = s.projectRefreshes.get(key)
    if (existing?.connection === conn) return existing.promise

    const promise = Promise.resolve()
      .then(async () => {
        const isCurrentConnection = () => s.connections.get(key) === conn && !conn.abort.signal.aborted
        if (!isCurrentConnection()) {
          throw new RefreshError({
            message: "Channel disconnected during project refresh",
            channelType,
            accountId,
          })
        }
        s.statuses.set(key, { status: "syncing" })
        try {
          await conn.provider.refreshProjects!({
            accountId,
            signal: conn.abort.signal,
            host: ChannelHost.create({
              channelType,
              accountId,
              onDiagnostic: async (record) => {
                await recordDiagnostic(channelType, accountId, record)
              },
            }),
          })
          if (!isCurrentConnection()) {
            throw new RefreshError({
              message: "Channel disconnected during project refresh",
              channelType,
              accountId,
            })
          }
          s.statuses.set(key, { status: "connected" })
        } catch (err) {
          const current = isCurrentConnection()
          const message = current
            ? err instanceof Error
              ? err.message
              : String(err)
            : "Channel disconnected during project refresh"
          if (current) s.statuses.set(key, { status: "failed", error: message })
          throw new RefreshError({ message, channelType, accountId })
        }
      })
      .finally(() => {
        if (s.projectRefreshes.get(key)?.promise === promise) s.projectRefreshes.delete(key)
      })
    s.projectRefreshes.set(key, { connection: conn, promise })
    return promise
  }

  export async function getDiagnostics(channelType: string, accountId: string): Promise<DiagnosticRecord[]> {
    return listDiagnostics(channelType, accountId)
  }

  export function streamDiagnostics(channelType: string, accountId: string): AsyncGenerator<DiagnosticRecord> {
    return iterateDiagnostics(channelType, accountId)
  }
  export async function init(): Promise<void> {
    await state()
  }

  /** Runtime Boss Mode routing helper (see handleMessage). */
  async function resolveBossRoutingSession(ctx: MessageContext): Promise<string | undefined> {
    if (ctx.channelType !== "feishu") return undefined
    const { BossRuntime } = await import("@/session/boss-runtime")
    return BossRuntime.bossSessionForAccount(ctx.accountId)
  }
}
