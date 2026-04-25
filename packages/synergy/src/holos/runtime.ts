import z from "zod"
import {
  MetaProtocolBash,
  MetaProtocolBridge,
  MetaProtocolEnvelope,
  MetaProtocolProcess,
  MetaProtocolSession,
} from "@ericsanchezok/meta-protocol"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import * as ChannelTypes from "@/channel/types"
import type { Config } from "@/config/config"
import { Instance } from "@/scope/instance"
import { Scope } from "@/scope"
import { State } from "@/scope/state"
import { Session } from "@/session"
import { SessionEndpoint } from "@/session/endpoint"
import { SessionInteraction } from "@/session/interaction"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { Flag } from "@/flag/flag"
import { Contact } from "./contact"
import { Envelope } from "./envelope"
import { FriendRequest } from "./friend-request"
import { HolosAuth } from "./auth"
import { HOLOS_PORTAL_URL, HOLOS_URL, HOLOS_WS_URL } from "./constants"
import { HolosLocalMeta, LocalMetaError } from "./local-meta"
import { releaseManagedMode, HolosLocalTakeover } from "./local-takeover"
import { HolosMessageMetadata } from "./message-metadata"
import { HolosOutbound } from "./outbound"
import { HolosProfile } from "./profile"
import { HolosProtocol } from "./protocol"
import { MessageQueue } from "./queue"
import { Presence } from "./presence"

const log = Log.create({ service: "holos.runtime" })
const HEARTBEAT_INTERVAL_MS = 30_000
const WS_FAILED_TIMEOUT_MS = 1_500
const RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 50

const SENT_MESSAGE_ID_LIMIT = 5_000
const SENT_MESSAGE_ID_PRUNE_BATCH = 1_000

type PendingSend = {
  timer: ReturnType<typeof setTimeout>
  resolve: () => void
  targetAgentId: string
  queueItemId?: string
  event?: string
  payload?: unknown
}

type ConnectionState = {
  ws: WebSocket | null
  peerId: string | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  managedLeaseTimer: ReturnType<typeof setInterval> | null
  pendingSends: Map<string, PendingSend>
  presencePoller: { stop: () => void } | null
  retryLoop: { stop: () => void } | null
}

type RuntimeConnection = {
  holosConfig: Config.Holos | null
  abort: AbortController
  status: HolosRuntime.Status
  provider: HolosProvider | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

async function fetchWsToken(apiUrl: string, agentSecret: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/v1/holos/agent_tunnel/ws_token`, {
    headers: { Authorization: `Bearer ${agentSecret}` },
  })
  if (!res.ok) throw new Error(`Failed to get ws_token: ${res.status} ${res.statusText}`)
  const body = HolosProtocol.WsTokenResponse.parse(await res.json())
  if (body.code !== 0) throw new Error(`ws_token request failed: ${body.message}`)
  return body.data.ws_token
}

function parseLocalMetaRequest(payload: unknown) {
  return MetaProtocolEnvelope.RequestBase.and(
    z.discriminatedUnion("tool", [
      MetaProtocolBash.ExecuteRequest,
      MetaProtocolProcess.ExecuteRequest,
      MetaProtocolSession.ExecuteRequest,
    ]),
  ).safeParse(payload)
}

function resolveTextOnlyParts(parts: ChannelTypes.OutboundPart[], operation: string) {
  const nonText = parts.find((part) => part.type !== "text")
  if (nonText) {
    throw new Error(`${operation} does not support outbound ${nonText.type} parts yet`)
  }
  return parts
    .filter((part): part is Extract<ChannelTypes.OutboundPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

async function syncRemoteExecution(input: { provider: HolosProvider } | null) {
  const { RemoteExecution } = await import("@/tool/remote-execution")
  if (!input) {
    RemoteExecution.setClient(null)
    return
  }
  const { HolosRemoteExecutionClient } = await import("@/remote/client")
  const { HolosRemoteExecutionTransport } = await import("@/remote/holos-transport")
  RemoteExecution.setClient(new HolosRemoteExecutionClient(new HolosRemoteExecutionTransport(input.provider)))
}

export namespace HolosRuntime {
  export const interactionSource = "holos"

  export type Status =
    | { status: "connected" }
    | { status: "connecting" }
    | { status: "disconnected" }
    | { status: "disabled" }
    | { status: "failed"; error: string }

  const state = State.create(
    () => "global",
    async (): Promise<RuntimeConnection> => ({
      holosConfig: null,
      abort: new AbortController(),
      status: { status: "disconnected" },
      provider: null,
      reconnectTimer: null,
    }),

    async (s: RuntimeConnection) => {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.reconnectTimer = null
      s.provider = null
      s.abort.abort()
    },
  )

  export type AppEventHandler = (input: {
    event: string
    payload: unknown
    caller: Envelope.Caller
  }) => boolean | Promise<boolean>

  export const Event = {
    Connected: BusEvent.define("holos.connected", z.object({ peerId: z.string() })),
    StatusChanged: BusEvent.define(
      "holos.connection.status_changed",
      z.object({ status: z.string(), error: z.string().optional() }),
    ),
    PresenceUpdate: BusEvent.define(
      "holos.presence",
      z.object({ peerId: z.string(), status: HolosProtocol.PeerStatus }),
    ),
  }

  function setStatus(current: RuntimeConnection, next: Status) {
    const prev = current.status.status
    current.status = next
    if (prev !== next.status) {
      Bus.publish(Event.StatusChanged, {
        status: next.status,
        ...("error" in next ? { error: next.error } : {}),
      }).catch((err) => log.warn("failed to publish status change", { error: err }))
    }
  }

  const appEventHandlers = new Set<AppEventHandler>()

  export async function getProvider(): Promise<HolosProvider | null> {
    const current = await state()
    return current.provider
  }

  export function sessionInfo(chatId: string): SessionEndpoint.Info {
    return SessionEndpoint.holos(chatId)
  }

  export function registerAppEventHandler(handler: AppEventHandler): () => void {
    appEventHandlers.add(handler)
    return () => {
      appEventHandlers.delete(handler)
    }
  }

  export async function dispatchAppEvent(input: {
    event: string
    payload: unknown
    caller: Envelope.Caller
  }): Promise<boolean> {
    for (const handler of appEventHandlers) {
      if (await handler(input)) return true
    }
    return false
  }

  async function syncRemoteExecutionState(current: RuntimeConnection) {
    await syncRemoteExecution(current.provider ? { provider: current.provider } : null)
  }

  export async function getOrCreateSession(chatId: string, scope: Scope = Scope.global()) {
    const current = await state()
    if (!current.provider) throw new Error("Holos not connected")
    return Session.getOrCreateForEndpoint(sessionInfo(chatId), scope, SessionInteraction.unattended(interactionSource))
  }

  export async function status(): Promise<Status> {
    const current = await state()
    return current.status
  }

  export async function init(): Promise<void> {
    const { Config } = await import("@/config/config")
    const cfg = await Config.get()
    let holos = cfg.holos
    if ((!holos || !holos.enabled) && Flag.SYNERGY_HOSTED && (await HolosAuth.getStoredCredential())) {
      holos = {
        enabled: true,
        apiUrl: HOLOS_URL,
        wsUrl: HOLOS_WS_URL,
        portalUrl: HOLOS_PORTAL_URL,
      }
    }
    const current = await state()

    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer)
      current.reconnectTimer = null
    }
    current.abort.abort()
    current.abort = new AbortController()
    current.holosConfig = holos ?? null
    current.provider = null
    setStatus(current, { status: "disconnected" })

    if (!holos || !holos.enabled) {
      setStatus(current, { status: "disabled" })
      return
    }

    setStatus(current, { status: "connecting" })

    void start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(current, { status: "failed", error: message })
    })
  }

  export async function start(): Promise<void> {
    const current = await state()
    if (!current.holosConfig) {
      setStatus(current, { status: "disabled" })
      return
    }

    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer)
      current.reconnectTimer = null
    }
    current.abort.abort()
    current.abort = new AbortController()
    const signal = current.abort.signal
    setStatus(current, { status: "connecting" })

    const provider = new HolosProvider()
    await provider.connect({
      config: current.holosConfig,
      signal,
      onDisconnect: (reason) => {
        if (signal.aborted) return
        current.provider = null
        void syncRemoteExecutionState(current).catch((err) =>
          log.warn("syncRemoteExecution failed", { error: err instanceof Error ? err.message : String(err) }),
        )
        setStatus(current, { status: "disconnected" })
        scheduleReconnect({ attempt: 0, reason })
      },
    })

    if (signal.aborted) return

    current.provider = provider
    setStatus(current, { status: "connected" })
    await syncRemoteExecutionState(current)
  }

  export async function stop(): Promise<void> {
    const current = await state()
    const peerId = current.provider?.peerId ?? null
    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer)
      current.reconnectTimer = null
    }
    current.provider = null
    current.abort.abort()
    if (peerId) {
      await releaseManagedMode(peerId).catch((err) =>
        log.warn("managed release failed during stop", { error: err instanceof Error ? err.message : String(err) }),
      )
    }
    setStatus(current, { status: "disconnected" })
    await syncRemoteExecutionState(current).catch((err) =>
      log.warn("syncRemoteExecution failed", { error: err instanceof Error ? err.message : String(err) }),
    )
  }

  export async function reload(): Promise<void> {
    await stop()
    await init()
  }

  function scheduleReconnect(input: { attempt: number; reason?: string }) {
    const { attempt, reason } = input
    void state().then((current) => {
      if (!current.holosConfig || current.abort.signal.aborted) return

      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setStatus(current, { status: "failed", error: "max reconnect attempts exceeded" })
        return
      }

      const delayMs = Math.min(RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
      setStatus(current, { status: "connecting" })

      if (current.reconnectTimer) clearTimeout(current.reconnectTimer)
      current.reconnectTimer = setTimeout(() => {
        current.reconnectTimer = null
        if (current.abort.signal.aborted) return
        start().catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          setStatus(current, { status: "failed", error: message })
          log.warn("holos reconnect failed", { attempt: attempt + 1, reason, error: message })
          scheduleReconnect({ attempt: attempt + 1, reason })
        })
      }, delayMs)
    })
  }
}

type ConnectInput = {
  config: Config.Holos
  signal: AbortSignal
  onDisconnect?: (reason?: string) => void
}

type PushMessageInput = {
  agentId: string
  parts: ChannelTypes.OutboundPart[]
}

type ReplyMessageInput = {
  messageId: string
  parts: ChannelTypes.OutboundPart[]
}

type StreamingSessionInput = {
  agentId: string
  replyToMessageId?: string
}

export class HolosProvider {
  readonly type = "holos"
  private state: ConnectionState = {
    ws: null,
    peerId: null,
    heartbeatTimer: null,
    managedLeaseTimer: null,
    pendingSends: new Map(),
    presencePoller: null,
    retryLoop: null,
  }
  private sentMessageIds = new Map<string, number>()
  private idCounter = 0
  private static readonly PROBE_WAIT_MS = 2_000

  get peerId() {
    return this.state.peerId
  }

  async connect(input: ConnectInput): Promise<void> {
    const { config: holosConfig, signal, onDisconnect } = input

    let capturedScope: Scope
    try {
      capturedScope = Instance.scope
    } catch {
      log.warn("Instance.scope unavailable during connect, falling back to global scope")
      capturedScope = Scope.global()
    }

    const credentials = await HolosAuth.getCredentialOrThrow()

    const takeover = await HolosLocalTakeover.takeover(credentials.agentId)
    if (takeover.metaDetected) {
      log.info("local meta-synergy takeover prepared", {
        handoff: takeover.handoff,
        controlAvailable: takeover.controlAvailable,
      })
    }

    const wsToken = await fetchWsToken(holosConfig.apiUrl, credentials.agentSecret)
    const wsEndpoint = `${holosConfig.wsUrl}/api/v1/holos/agent_tunnel/ws?token=${wsToken}`
    const ws = new WebSocket(wsEndpoint)

    this.state = {
      ws,
      peerId: credentials.agentId,
      heartbeatTimer: null,
      managedLeaseTimer: null,
      pendingSends: new Map(),
      presencePoller: null,
      retryLoop: null,
    }

    return new Promise<void>((resolve, reject) => {
      let opened = false
      let cleanedUp = false
      const subs: Array<() => void> = []

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        if (this.state.heartbeatTimer) clearInterval(this.state.heartbeatTimer)
        if (this.state.managedLeaseTimer) clearInterval(this.state.managedLeaseTimer)
        this.state.presencePoller?.stop()
        this.state.retryLoop?.stop()
        for (const unsub of subs) unsub()
        for (const pending of this.state.pendingSends.values()) clearTimeout(pending.timer)
        this.state.pendingSends.clear()
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
        this.state.ws = null
        this.state.peerId = null
      }

      signal.addEventListener("abort", cleanup, { once: true })

      ws.addEventListener("open", () => {
        opened = true
        resolve()

        this.state.heartbeatTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(Envelope.ping())
          } catch (err) {
            log.warn("heartbeat send failed", { error: err instanceof Error ? err.message : String(err) })
          }
        }, HEARTBEAT_INTERVAL_MS)
        this.state.heartbeatTimer.unref?.()

        this.state.managedLeaseTimer = setInterval(() => {
          void this.refreshManagedLease().catch((err: unknown) =>
            log.warn("managed lease refresh failed", { error: err instanceof Error ? err.message : String(err) }),
          )
        }, 5_000)
        this.state.managedLeaseTimer.unref?.()

        Instance.provide({
          scope: capturedScope,
          fn: () => {
            this.startBackgroundLoops()
            subs.push(HolosOutbound.init())
            subs.push(
              Bus.subscribe(HolosProfile.Event.Updated, () => {
                this.notifyProfileUpdate().catch((err) =>
                  log.warn("failed to broadcast profile update", {
                    error: err instanceof Error ? err.message : String(err),
                  }),
                )
              }),
            )
            Bus.publish(HolosRuntime.Event.Connected, { peerId: credentials.agentId })
          },
        }).catch((err) => log.warn("non-critical setup after ws open failed", { error: err }))
      })

      ws.addEventListener("message", (event) => {
        try {
          const parsed = Envelope.parse(event.data as string)
          if (!parsed) return
          Instance.provide({
            scope: capturedScope,
            fn: () => this.handleParsedMessage(parsed),
          }).catch((err) =>
            log.error("failed to handle websocket message", {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        } catch (err) {
          log.error("failed to handle websocket message", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })

      ws.addEventListener("close", () => {
        cleanup()
        if (!opened) {
          reject(new Error("WebSocket connection failed"))
        } else if (onDisconnect) {
          Instance.provide({ scope: capturedScope, fn: () => onDisconnect("ws_closed") }).catch((err) =>
            log.warn("disconnect handler failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })

      ws.addEventListener("error", (event) => {
        log.error("websocket error", { error: event })
      })
    })
  }

  private startBackgroundLoops(): void {
    this.state.presencePoller = Presence.startPolling({
      getFriendIds: () => this.listPresenceTargetIds(),
      sendPing: (agentId) => this.sendPresencePing(agentId),
    })

    this.state.retryLoop = MessageQueue.startRetryLoop({
      sendFn: async (item) => {
        if (!this.state.ws) throw new Error("Not connected")
        const requestId = crypto.randomUUID()
        this.state.ws.send(
          Envelope.wsSend({
            targetAgentId: item.targetAgentId,
            event: item.event,
            payload: item.payload,
            requestId,
          }),
        )
        this.trackSend(requestId, item.targetAgentId, item.id)
        return requestId
      },
      probeFn: (agentId) => this.sendPresencePing(agentId),
      isOnline: (agentId) => Presence.get(agentId) !== "offline",
    })
  }

  private async listPresenceTargetIds(): Promise<string[]> {
    const contacts = await Contact.list()
    return contacts.filter((contact) => contact.holosId && !contact.config.blocked).map((contact) => contact.holosId!)
  }

  private sendPresencePing(agentId: string): void {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) return
    const requestId = crypto.randomUUID()
    this.state.ws.send(Envelope.wsSend({ targetAgentId: agentId, event: "presence.ping", payload: {}, requestId }))
    this.trackSend(requestId, agentId)
  }

  private async refreshManagedLease(): Promise<void> {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN || !this.state.peerId) return
    await HolosLocalTakeover.refreshManagedLease(this.state.peerId)
  }

  async refreshPresence(): Promise<{ count: number }> {
    const agentIds = await this.listPresenceTargetIds()
    for (const agentId of agentIds) this.sendPresencePing(agentId)
    return { count: agentIds.length }
  }

  private trackSend(requestId: string, targetAgentId: string, queueItemId?: string): void {
    const timer = setTimeout(() => {
      try {
        if (!this.state.pendingSends.has(requestId)) return
        this.state.pendingSends.delete(requestId)
        Presence.markOnline(targetAgentId)
        if (queueItemId) void MessageQueue.markDelivered(queueItemId)
      } catch (err) {
        log.warn("trackSend timeout callback failed", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, WS_FAILED_TIMEOUT_MS)

    this.state.pendingSends.set(requestId, { timer, resolve: () => {}, targetAgentId, queueItemId })
  }

  async send(targetAgentId: string, event: string, payload: unknown): Promise<{ queued: boolean }> {
    if (!this.state.ws) throw new Error("Not connected")

    let status = Presence.get(targetAgentId)
    if (status === "unknown" && this.state.ws.readyState === WebSocket.OPEN) {
      const probeId = crypto.randomUUID()
      this.state.ws.send(Envelope.wsSend({ targetAgentId, event: "presence.ping", payload: {}, requestId: probeId }))
      this.trackSend(probeId, targetAgentId)
      const deadline = Date.now() + HolosProvider.PROBE_WAIT_MS
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const current = Presence.get(targetAgentId)
        if (current !== "unknown") {
          status = current
          break
        }
      }
      if (status === "unknown") status = Presence.get(targetAgentId)
    }

    if (status === "offline") {
      await MessageQueue.enqueue({ targetAgentId, event, payload })
      return { queued: true }
    }

    const requestId = crypto.randomUUID()
    this.state.ws.send(Envelope.wsSend({ targetAgentId, event, payload, requestId }))

    return new Promise<{ queued: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.state.pendingSends.has(requestId)) return
        this.state.pendingSends.delete(requestId)
        Presence.markOnline(targetAgentId)
        resolve({ queued: false })
      }, WS_FAILED_TIMEOUT_MS)

      this.state.pendingSends.set(requestId, {
        timer,
        resolve: () => resolve({ queued: true }),
        targetAgentId,
        event,
        payload,
      })
    })
  }

  async pushMessage(input: PushMessageInput): Promise<ChannelTypes.SendResult> {
    const text = resolveTextOnlyParts(input.parts, "Holos pushMessage")
    const messageId = this.generateMessageId()
    await this.send(input.agentId, "chat.message", {
      text,
      messageId,
    } satisfies HolosProtocol.ChatMessagePayload)
    return { messageId }
  }

  async replyMessage(input: ReplyMessageInput): Promise<ChannelTypes.SendResult> {
    const peerIdFromMessage = this.extractPeerFromMessageId(input.messageId)
    const msgId = this.generateMessageId()
    const text = resolveTextOnlyParts(input.parts, "Holos replyMessage")
    await this.send(peerIdFromMessage, "chat.message", {
      text,
      messageId: msgId,
    } satisfies HolosProtocol.ChatMessagePayload)
    return { messageId: msgId }
  }

  async addReaction(_input: {
    accountId: string
    messageId: string
    emoji: string
  }): Promise<{ reactionId: string } | void> {}

  createStreamingSession(input: StreamingSessionInput): ChannelTypes.StreamingSession {
    return new HolosNonStreamingSession(this, input.agentId)
  }

  async sendFriendRequest(peerId: string, peerName?: string, peerBio?: string): Promise<{ queued: boolean }> {
    const profile = await this.buildPeerProfile()
    const result = await this.send(peerId, "friend.request", {
      profile,
    } satisfies HolosProtocol.FriendRequestPayload)
    await FriendRequest.create({
      id: `fr_${peerId}_${Date.now()}`,
      direction: "outgoing",
      peerId,
      peerName,
      peerBio,
      status: result.queued ? "pending_delivery" : "pending",
      createdAt: Date.now(),
    })
    return result
  }

  async acceptFriendRequest(peerId: string): Promise<{ queued: boolean }> {
    const profile = await this.buildPeerProfile()
    const result = await this.send(peerId, "friend.accept", {
      profile,
    } satisfies HolosProtocol.FriendAcceptPayload)
    if (result.queued) log.info("friend.accept queued for offline peer", { peerId })
    return result
  }

  async rejectFriendRequest(peerId: string): Promise<{ queued: boolean }> {
    const result = await this.send(peerId, "friend.reject", {} satisfies HolosProtocol.FriendRejectPayload)
    if (result.queued) log.info("friend.reject queued for offline peer", { peerId })
    return result
  }

  async removeFriend(peerId: string): Promise<{ queued: boolean }> {
    const result = await this.send(peerId, "friend.remove", {} satisfies HolosProtocol.FriendRemovePayload)
    if (result.queued) log.info("friend.remove queued for offline peer", { peerId })
    return result
  }

  async sendMessage(
    peerId: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<{ queued: boolean; messageId: string }> {
    const contact = await Contact.get(peerId)
    if (!contact) throw new Error(`Contact ${peerId} not found`)
    if (contact.config.blocked) throw new Error(`Contact ${peerId} is blocked`)
    if (!contact.config.autoInitiate) throw new Error(`autoInitiate is disabled for contact ${peerId}`)

    const messageId = this.generateMessageId()
    const result = await this.send(peerId, "chat.message", {
      text,
      messageId,
      replyTo: options?.replyToMessageId,
    } satisfies HolosProtocol.ChatMessagePayload)
    return { queued: result.queued, messageId }
  }

  async sendChatMessage(
    contactId: string,
    text: string,
    options?: { source?: HolosProtocol.ChatMessagePayload["source"]; replyToMessageId?: string },
  ): Promise<{ queued: boolean; messageId: string }> {
    const messageId = this.generateMessageId()
    const result = await this.send(contactId, "chat.message", {
      text,
      messageId,
      replyTo: options?.replyToMessageId,
      source: options?.source,
    } satisfies HolosProtocol.ChatMessagePayload)
    return { queued: result.queued, messageId }
  }

  async notifyProfileUpdate(): Promise<void> {
    const profile = await this.buildPeerProfile()
    const contacts = await Contact.list()
    const targets = contacts.filter((c) => c.holosId && !c.config.blocked)
    const results = await Promise.allSettled(
      targets.map((contact) =>
        this.send(contact.holosId!, "profile.update", {
          profile,
        } satisfies HolosProtocol.ProfileUpdatePayload),
      ),
    )
    const failed = results.filter((r) => r.status === "rejected")
    if (failed.length > 0) {
      log.warn("profile broadcast partially failed", { total: targets.length, failed: failed.length })
    }
  }

  private handleParsedMessage(msg: Envelope.Parsed): void {
    switch (msg.kind) {
      case "pong":
      case "unknown":
        break
      case "error":
        log.error("gateway error", { code: msg.code, message: msg.message })
        break
      case "ws_failed":
        this.handleWsFailed(msg)
        break
      case "ws_send":
        Presence.markOnline(msg.caller.agent_id)
        this.handleAppEvent(msg.event, msg.payload, msg.caller)
        break
      case "http_request":
        this.handleHttpRequest(msg)
        break
    }
  }

  private handleWsFailed(msg: Extract<Envelope.Parsed, { kind: "ws_failed" }>): void {
    const pending = this.state.pendingSends.get(msg.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.state.pendingSends.delete(msg.requestId)
    Presence.markOffline(pending.targetAgentId)

    if (pending.queueItemId) {
      void MessageQueue.markFailed(pending.queueItemId)
    } else if (pending.event && pending.payload !== undefined) {
      void MessageQueue.enqueue({
        targetAgentId: pending.targetAgentId,
        event: pending.event,
        payload: pending.payload,
      }).catch((err) => log.warn("failed to enqueue after ws_failed", { error: err }))
      pending.resolve()
    } else {
      pending.resolve()
    }
  }

  private handleAppEvent(event: string, payload: unknown, caller: Envelope.Caller): void {
    void HolosRuntime.dispatchAppEvent({ event, payload, caller })
      .then((handled) => {
        if (handled) return

        if (event === MetaProtocolBridge.RequestEvent) {
          return this.handleLocalMetaExecution(caller, payload)
        }

        switch (event) {
          case "friend.request":
            return this.handleFriendRequest(caller, payload)
          case "friend.accept":
            return this.handleFriendAccept(caller, payload)
          case "friend.reject":
            return this.handleFriendReject(caller)
          case "friend.remove":
            return this.handleFriendRemove(caller)
          case "chat.message":
            return this.handleChatMessage(caller, payload)
          case "profile.update":
            return this.handleProfileUpdate(caller, payload)
          case "presence.ping":
            return this.handlePresencePing(caller)
          case "presence.pong":
            this.handlePresencePong(caller, payload)
            return
          default:
            log.warn("unknown app event", { event })
        }
      })
      .catch((err) =>
        log.error("app event handler failed", { event, error: err instanceof Error ? err.message : String(err) }),
      )
  }

  private async handleFriendRequest(caller: Envelope.Caller, payload: unknown): Promise<void> {
    const parsed = HolosProtocol.FriendRequestPayload.safeParse(payload)
    if (!parsed.success) return
    await FriendRequest.create({
      id: `fr_${caller.agent_id}_${Date.now()}`,
      direction: "incoming",
      peerId: caller.agent_id,
      peerName: parsed.data.profile.name,
      peerBio: parsed.data.profile.bio,
      status: "pending",
      createdAt: Date.now(),
    })
    const existing = await Contact.get(caller.agent_id)
    if (existing) {
      await Contact.update({
        ...existing,
        name: parsed.data.profile.name,
        bio: parsed.data.profile.bio,
      })
    }
  }

  private async handleFriendAccept(caller: Envelope.Caller, payload: unknown): Promise<void> {
    const parsed = HolosProtocol.FriendAcceptPayload.safeParse(payload)
    if (!parsed.success) return

    const requests = await FriendRequest.list()
    const request = requests.find(
      (entry) =>
        entry.peerId === caller.agent_id &&
        entry.direction === "outgoing" &&
        (entry.status === "pending" || entry.status === "pending_delivery"),
    )
    if (request) await FriendRequest.respond(request.id, "accepted")

    const existing = await Contact.get(caller.agent_id)
    if (existing) {
      await Contact.update({
        ...existing,
        name: parsed.data.profile.name,
        bio: parsed.data.profile.bio,
      })
      return
    }

    await Contact.add({
      id: caller.agent_id,
      holosId: caller.agent_id,
      name: parsed.data.profile.name,
      bio: parsed.data.profile.bio,
      status: "active",
      addedAt: Date.now(),
      config: { autoReply: false, autoInitiate: false, blocked: false, maxAutoTurns: 10 },
    })
  }

  private async handleFriendReject(caller: Envelope.Caller): Promise<void> {
    const requests = await FriendRequest.list()
    const request = requests.find(
      (entry) =>
        entry.peerId === caller.agent_id &&
        entry.direction === "outgoing" &&
        (entry.status === "pending" || entry.status === "pending_delivery"),
    )
    if (request) await FriendRequest.respond(request.id, "rejected")
  }

  private async handleFriendRemove(caller: Envelope.Caller): Promise<void> {
    const contacts = await Contact.list()
    const contact = contacts.find((entry) => entry.holosId === caller.agent_id)
    if (!contact) return
    await Contact.remove(contact.id)
    Presence.remove(caller.agent_id)
  }

  private async handleChatMessage(caller: Envelope.Caller, payload: unknown): Promise<void> {
    if (!this.state.peerId || caller.agent_id === this.state.peerId) return

    const parsed = HolosProtocol.ChatMessagePayload.safeParse(payload)
    if (!parsed.success) return
    if (parsed.data.messageId && this.sentMessageIds.has(parsed.data.messageId)) return

    const contact = await Contact.get(caller.agent_id)
    if (!contact || contact.config.blocked) return

    const session = await Session.getOrCreateForEndpoint(
      HolosRuntime.sessionInfo(caller.agent_id),
      undefined,
      SessionInteraction.unattended(HolosRuntime.interactionSource),
    )

    const messageID = Identifier.ascending("message")
    const textPart: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID,
      type: "text",
      text: parsed.data.text,
    }

    const quotedMessage = parsed.data.replyTo
      ? (await Session.messages({ sessionID: session.id, limit: 200 })).find((message) => {
          const metadata = (message.info.metadata as Record<string, unknown> | undefined) ?? {}
          return HolosMessageMetadata.holos(metadata)?.messageId === parsed.data.replyTo
        })
      : undefined
    const quotedText = MessageV2.extractText(quotedMessage?.parts ?? [])

    const userMessage: MessageV2.Info = {
      id: messageID,
      role: "user",
      sessionID: session.id,
      time: { created: Date.now() },
      agent: "friend",
      model: { providerID: "none", modelID: "none" },
      metadata: HolosMessageMetadata.merge(undefined, {
        source: parsed.data.source,
        holos: {
          inbound: true,
          senderId: caller.agent_id,
          senderName: contact.name,
          messageId: parsed.data.messageId,
          replyToMessageId: parsed.data.replyTo,
        },
        quote: quotedMessage
          ? {
              messageId: quotedMessage.info.id,
              text: quotedText || undefined,
              senderName: quotedMessage.info.role === "user" ? contact.name : "You",
            }
          : undefined,
      }),
    }

    await Session.updatePart(textPart)
    await Session.updateMessage(userMessage)
    if (!contact.config.autoReply) return

    const { FriendReply } = await import("./friend-reply")
    await FriendReply.process({
      friendSessionId: session.id,
      triggerMessageId: textPart.messageID,
      contactId: caller.agent_id,
      contactName: contact.name,
      messageText: parsed.data.text,
      contact,
    }).catch((err: unknown) => {
      log.error("friend reply failed", { sessionID: session.id, contactId: caller.agent_id, error: err })
    })
  }

  private async handleProfileUpdate(caller: Envelope.Caller, payload: unknown): Promise<void> {
    const parsed = HolosProtocol.ProfileUpdatePayload.safeParse(payload)
    if (!parsed.success) return
    const contact = await Contact.get(caller.agent_id)
    if (!contact) return

    await Contact.update({
      ...contact,
      name: parsed.data.profile.name,
      bio: parsed.data.profile.bio,
    })
  }

  private async handlePresencePing(caller: Envelope.Caller): Promise<void> {
    Presence.markOnline(caller.agent_id)
    const profile = await this.buildPeerProfile()
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
      this.state.ws.send(
        Envelope.wsSend({
          targetAgentId: caller.agent_id,
          event: "presence.pong",
          payload: { profile } satisfies HolosProtocol.PresencePongPayload,
        }),
      )
    }
  }

  private handlePresencePong(caller: Envelope.Caller, payload: unknown): void {
    Presence.markOnline(caller.agent_id)
    const parsed = HolosProtocol.PresencePongPayload.safeParse(payload)
    if (!parsed.success) return

    void Contact.get(caller.agent_id).then(async (contact) => {
      if (!contact) return
      const nameChanged = contact.name !== parsed.data.profile.name
      const bioChanged = contact.bio !== parsed.data.profile.bio
      if (nameChanged || bioChanged) {
        await Contact.update({
          ...contact,
          name: parsed.data.profile.name,
          bio: parsed.data.profile.bio,
        })
      }
    })
  }

  private handleHttpRequest(msg: Extract<Envelope.Parsed, { kind: "http_request" }>): void {
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
      this.state.ws.send(
        Envelope.httpResponse({
          requestId: msg.requestId,
          statusCode: 404,
          payload: { error: "No HTTP endpoints available" },
        }),
      )
    }
  }

  private async handleLocalMetaExecution(caller: Envelope.Caller, payload: unknown): Promise<void> {
    const request = parseLocalMetaRequest(payload)
    if (!request.success) {
      const requestID =
        typeof payload === "object" &&
        payload !== null &&
        "requestID" in payload &&
        typeof (payload as { requestID?: unknown }).requestID === "string"
          ? ((payload as { requestID: string }).requestID as string)
          : null
      if (!requestID) return
      await this.send(caller.agent_id, MetaProtocolBridge.ResponseEvent, {
        version: 1,
        requestID,
        ok: false,
        tool:
          typeof payload === "object" &&
          payload !== null &&
          "tool" in payload &&
          MetaProtocolEnvelope.Tool.safeParse((payload as { tool?: unknown }).tool).success
            ? ((payload as { tool: MetaProtocolEnvelope.Tool }).tool as MetaProtocolEnvelope.Tool)
            : undefined,
        action:
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          typeof (payload as { action?: unknown }).action === "string"
            ? ((payload as { action: string }).action as string)
            : undefined,
        error: {
          code: "invalid_request",
          message: "Invalid meta execution request.",
          details: request.error.issues,
        },
      })
      return
    }

    let response: unknown
    try {
      response = await HolosLocalMeta.execute(caller, request.data)
    } catch (error) {
      const normalized =
        error instanceof LocalMetaError
          ? error
          : new LocalMetaError("host_internal_error", error instanceof Error ? error.message : String(error), error)
      response = {
        version: 1,
        requestID: request.data.requestID,
        ok: false,
        tool: request.data.tool,
        action: request.data.action,
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        },
      } satisfies MetaProtocolEnvelope.ErrorResult
    }

    const result = await this.send(caller.agent_id, MetaProtocolBridge.ResponseEvent, response)
    if (result.queued) {
      log.warn("local meta response queued instead of delivered", {
        targetAgentId: caller.agent_id,
        requestID: request.data.requestID,
      })
    }
  }

  private generateMessageId(): string {
    const id = `hol_${Date.now()}_${++this.idCounter}`
    this.sentMessageIds.set(id, Date.now())
    if (this.sentMessageIds.size > SENT_MESSAGE_ID_LIMIT) {
      const entries = [...this.sentMessageIds.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, SENT_MESSAGE_ID_PRUNE_BATCH)
      for (const [key] of entries) this.sentMessageIds.delete(key)
    }
    return id
  }

  private async buildPeerProfile(): Promise<HolosProtocol.PeerProfile> {
    const profile = await HolosProfile.get()
    return {
      name: profile?.name ?? "Unknown",
      bio: profile?.bio,
    }
  }

  private extractPeerFromMessageId(messageId: string): string {
    const parts = messageId.split(":")
    if (parts[0] === "peer" && parts[1]) return parts[1]
    return messageId
  }
}

class HolosNonStreamingSession implements ChannelTypes.StreamingSession {
  private active = false
  private finalText = ""

  constructor(
    private provider: HolosProvider,
    private chatId: string,
  ) {}

  async start(): Promise<void> {
    this.active = true
  }

  async update(text: string): Promise<void> {
    this.finalText = text
  }

  async updateToolProgress(_progress: ChannelTypes.StreamingToolProgress[]): Promise<void> {}

  async close(finalText?: string): Promise<void> {
    this.active = false
    const text = finalText ?? this.finalText
    if (!text) return

    try {
      await this.provider.replyMessage({
        messageId: `peer:${this.chatId}:reply`,
        parts: [{ type: "text", text }],
      })
    } catch (err) {
      log.error("failed to send reply", { chatId: this.chatId, error: err })
    }
  }

  isActive(): boolean {
    return this.active
  }
}
