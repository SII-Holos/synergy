import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import type { Config } from "@/config/config"
import { ScopeContext } from "@/scope/context"
import { Scope } from "@/scope"
import { State } from "@/scope/state"
import { Log } from "@/util/log"
import { Contact } from "./contact"
import { Envelope } from "./envelope"
import { HolosAuth } from "./auth"
import { HolosProfile } from "./profile"
import { HolosProtocol } from "./protocol"
import { Presence } from "./presence"

const log = Log.create({ service: "holos.runtime" })
const HEARTBEAT_INTERVAL_MS = 30_000
const WS_FAILED_TIMEOUT_MS = 1_500
const RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 50

type PendingSend = {
  timer: ReturnType<typeof setTimeout>
  resolve: (result: { sent: boolean; reason?: string }) => void
  targetAgentId: string
}

type ConnectionState = {
  ws: WebSocket | null
  peerId: string | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  pendingSends: Map<string, PendingSend>
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

async function syncSynergyLink(input: { provider: HolosProvider } | null) {
  const { SynergyLinkExecution } = await import("@/tool/synergy-link-execution")
  if (!input) {
    SynergyLinkExecution.setClient(null)
    return
  }
  const { HolosSynergyLinkClient } = await import("@/remote/client")
  const { HolosSynergyLinkTransport } = await import("@/remote/holos-transport")
  SynergyLinkExecution.setClient(new HolosSynergyLinkClient(new HolosSynergyLinkTransport(input.provider)))
}

export namespace HolosRuntime {
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

  export async function status(): Promise<Status> {
    const current = await state()
    return current.status
  }

  export async function init(): Promise<void> {
    const { Config } = await import("@/config/config")
    const cfg = await Config.current()
    const holos = cfg.holos
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
        void syncSynergyLink(null).catch((err) => log.warn("syncSynergyLink failed", { error: err }))
        setStatus(current, { status: "disconnected" })
        scheduleReconnect({ attempt: 0, reason })
      },
    })

    if (signal.aborted) return

    current.provider = provider
    setStatus(current, { status: "connected" })
    await syncSynergyLink({ provider })
  }

  export async function stop(): Promise<void> {
    const current = await state()
    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer)
      current.reconnectTimer = null
    }
    current.provider = null
    current.abort.abort()
    setStatus(current, { status: "disconnected" })
    await syncSynergyLink(null).catch((err) => log.warn("syncSynergyLink failed", { error: err }))
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

export class HolosProvider {
  readonly type = "holos"
  private holosConfig: Config.Holos | null = null
  private state: ConnectionState = {
    ws: null,
    peerId: null,
    heartbeatTimer: null,
    pendingSends: new Map(),
  }

  get peerId() {
    return this.state.peerId
  }

  async connect(input: ConnectInput): Promise<void> {
    const { config: holosConfig, signal, onDisconnect } = input
    this.holosConfig = holosConfig

    let capturedScope: Scope
    try {
      capturedScope = ScopeContext.current.scope
    } catch {
      log.warn("ScopeContext.current.scope unavailable during connect, falling back to home scope")
      capturedScope = Scope.home()
    }

    const credentials = await HolosAuth.getCredentialOrThrow()

    const wsToken = await fetchWsToken(holosConfig.apiUrl, credentials.agentSecret)
    const wsEndpoint = `${holosConfig.wsUrl}/api/v1/holos/agent_tunnel/ws?token=${wsToken}`
    const ws = new WebSocket(wsEndpoint)

    this.state = {
      ws,
      peerId: credentials.agentId,
      heartbeatTimer: null,
      pendingSends: new Map(),
    }

    return new Promise<void>((resolve, reject) => {
      let opened = false
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        if (this.state.heartbeatTimer) clearInterval(this.state.heartbeatTimer)
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
            log.warn("heartbeat send failed", { error: err })
          }
        }, HEARTBEAT_INTERVAL_MS)
        this.state.heartbeatTimer.unref?.()

        ScopeContext.provide({
          scope: capturedScope,
          fn: () => {
            Bus.publish(HolosRuntime.Event.Connected, { peerId: credentials.agentId })
          },
        }).catch((err) => log.warn("non-critical setup after ws open failed", { error: err }))
      })

      ws.addEventListener("message", (event) => {
        try {
          const parsed = Envelope.parse(event.data as string)
          if (!parsed) return
          ScopeContext.provide({
            scope: capturedScope,
            fn: () => this.handleParsedMessage(parsed),
          }).catch((err) =>
            log.error("failed to handle websocket message", {
              error: err,
            }),
          )
        } catch (err) {
          log.error("failed to handle websocket message", {
            error: err,
          })
        }
      })

      ws.addEventListener("close", () => {
        cleanup()
        if (!opened) {
          reject(new Error("WebSocket connection failed"))
        } else if (onDisconnect) {
          ScopeContext.provide({ scope: capturedScope, fn: () => onDisconnect("ws_closed") }).catch((err) =>
            log.warn("disconnect handler failed", {
              error: err,
            }),
          )
        }
      })

      ws.addEventListener("error", (event) => {
        log.error("websocket error", { error: event })
      })
    })
  }

  async send(targetAgentId: string, event: string, payload: unknown): Promise<{ sent: boolean; reason?: string }> {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) {
      return { sent: false, reason: "not_connected" }
    }
    const status = Presence.get(targetAgentId)
    if (status === "offline") {
      return { sent: false, reason: "offline" }
    }
    // unknown or online -> try sending
    const requestId = crypto.randomUUID()
    this.state.ws.send(Envelope.wsSend({ targetAgentId, event, payload, requestId }))

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.state.pendingSends.has(requestId)) {
          this.state.pendingSends.delete(requestId)
          resolve({ sent: false, reason: "timeout" })
        }
      }, WS_FAILED_TIMEOUT_MS)
      this.state.pendingSends.set(requestId, { timer, resolve, targetAgentId })
    })
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
    }
  }

  private handleWsFailed(msg: Extract<Envelope.Parsed, { kind: "ws_failed" }>): void {
    const pending = this.state.pendingSends.get(msg.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.state.pendingSends.delete(msg.requestId)
    Presence.markOffline(pending.targetAgentId)
    pending.resolve({ sent: false, reason: "delivery_failed" })
  }

  private handleAppEvent(event: string, payload: unknown, caller: Envelope.Caller): void {
    void HolosRuntime.dispatchAppEvent({ event, payload, caller })
      .then((handled) => {
        if (handled) return

        switch (event) {
          case "chat.message":
            return this.handleChatMessage(caller, payload)
          case "presence.ping":
            return this.handlePresencePing(caller)
          case "presence.pong":
            this.handlePresencePong(caller, payload)
            return
          default:
            log.warn("unknown app event", { event })
        }
      })
      .catch((err) => log.error("app event handler failed", { event, error: err }))
  }

  private async handleChatMessage(caller: Envelope.Caller, payload: unknown): Promise<void> {
    // Silently drop: DO NOT echo our own messages back into the inbox.
    // In multi-device scenarios, outbox sync is handled by the Mailbox module directly.
    if (!this.state.peerId || caller.agent_id === this.state.peerId) return

    const parsed = HolosProtocol.ChatMessagePayload.safeParse(payload)
    if (!parsed.success) return

    // Check blocked list
    const contact = await Contact.get(caller.agent_id)
    if (contact?.blocked) {
      log.info("message blocked", { from: caller.agent_id })
      return
    }

    // Write to inbox
    try {
      const { Mailbox } = await import("./mailbox")
      await Mailbox.receive({
        fromId: caller.agent_id,
        text: parsed.data.text,
        messageId: parsed.data.messageId,
        source: parsed.data.source,
      })
      log.info("message received", { from: caller.agent_id })
    } catch (err) {
      log.error("mailbox receive failed", { from: caller.agent_id, error: err })
    }
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

    // Update the contact name if the peer's profile name changed.
    // This is a best-effort sync — contacts are manually managed, but
    // catching name updates from presence pongs keeps the list current.
    void Contact.get(caller.agent_id).then(async (contact) => {
      if (!contact) return
      if (contact.name !== parsed.data.profile.name) {
        await Contact.update({
          ...contact,
          name: parsed.data.profile.name,
        })
      }
    })
  }

  private async buildPeerProfile(): Promise<HolosProtocol.PeerProfile> {
    const credential = await HolosAuth.getStoredCredential()
    if (!credential) return { name: "Synergy" }
    try {
      const me = await HolosProfile.getCurrent({
        agentId: credential.agentId,
        agentSecret: credential.agentSecret,
        apiUrl: this.holosConfig?.apiUrl,
      })
      return {
        name: me.profile.name.trim() || credential.agentId.slice(0, 8),
        description: me.profile.description.trim() || undefined,
      }
    } catch {
      return {
        name: credential.agentId.slice(0, 8) || "Synergy",
      }
    }
  }
}
