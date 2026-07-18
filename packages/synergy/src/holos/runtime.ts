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
import { clampNativeRequestTimeout, secureHolosFetch, validateHolosEndpoint } from "./security"
import { HolosAuth } from "./auth"
import { HolosProfile } from "./profile"
import { HolosProtocol } from "./protocol"
import { Presence } from "./presence"
import type { NativeMessage, NativeTunnelPort, HolosConnectionEvent, NativeRequestFailure } from "./native"

const log = Log.create({ service: "holos.runtime" })
const HEARTBEAT_INTERVAL_MS = 30_000
const WS_FAILED_TIMEOUT_MS = 1_500
const RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 50
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

type UnifiedPending =
  | {
      kind: "ws_send"
      timer: ReturnType<typeof setTimeout>
      resolve: (r: { sent: boolean; reason?: string }) => void
      targetAgentId: string
    }
  | {
      kind: "native_request"
      resolve: (msg: NativeMessage) => void
      reject: (f: NativeRequestFailure) => void
      timer: ReturnType<typeof setTimeout> | null
      expectedResponseType: string
      signal?: AbortSignal
      abortListener?: () => void
    }

type RuntimeConnection = {
  holosConfig: Config.Holos | null
  abort: AbortController
  status: HolosRuntime.Status
  provider: HolosProvider | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  generation: number
  epoch: number
  sessionID: string | null
  nativeObservers: Set<(msg: NativeMessage) => void | Promise<void>>
  connectionObservers: Set<(event: HolosConnectionEvent) => void | Promise<void>>
}

type ConnectionState = {
  ws: WebSocket | null
  peerId: string | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

// Each provider gets its own generation track
type ProviderGeneration = { emitted: boolean; sessionID: string | null }

async function fetchWsToken(apiUrl: string, agentSecret: string, signal?: AbortSignal): Promise<string> {
  const url = `${apiUrl}/api/v1/holos/agent_tunnel/ws_token`
  const res = await secureHolosFetch({
    url,
    kind: "api",
    secret: agentSecret,
    signal,
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

class NativeTunnelPortImpl implements NativeTunnelPort {
  constructor(private readonly connection: RuntimeConnection) {}

  registerNativeObserver(handler: (message: NativeMessage) => void | Promise<void>): () => void {
    this.connection.nativeObservers.add(handler)
    return () => {
      this.connection.nativeObservers.delete(handler)
    }
  }

  registerConnectionObserver(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connection.connectionObservers.add(handler)
    return () => {
      this.connection.connectionObservers.delete(handler)
    }
  }

  sendNativeRequest(input: Parameters<HolosProvider["sendNativeRequest"]>[0]) {
    const provider = this.connection.provider
    if (!provider) {
      throw {
        disposition: "rejected" as const,
        requestID: input.requestID,
        code: "NOT_CONNECTED",
        message: "Holos Agent Tunnel is not connected",
      }
    }
    return provider.sendNativeRequest(input)
  }
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
      generation: 0,
      epoch: Date.now(),
      sessionID: null,
      nativeObservers: new Set(),
      connectionObservers: new Set(),
    }),

    async (s: RuntimeConnection) => {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
      s.reconnectTimer = null
      const provider = s.provider
      if (provider) provider.settle()
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

  export async function getNativeTunnel(): Promise<NativeTunnelPort> {
    return new NativeTunnelPortImpl(await state())
  }

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
    // Settle previous provider before resetting
    const prevProvider = current.provider
    if (prevProvider) prevProvider.settle()
    current.abort.abort()
    current.abort = new AbortController()
    current.holosConfig = holos ?? null
    current.provider = null
    current.sessionID = null
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
    // Settle previous provider before creating a new one
    const prevProvider = current.provider
    if (prevProvider) {
      prevProvider.settle()
      current.provider = null
    }
    current.abort.abort()
    current.abort = new AbortController()
    const signal = current.abort.signal
    setStatus(current, { status: "connecting" })

    const provider = new HolosProvider(current)
    current.provider = provider
    try {
      await provider.connect({
        config: current.holosConfig,
        signal,
        onDisconnect: (reason) => {
          if (signal.aborted) return
          // Guard: only act if this provider is still current
          if (current.provider !== provider) return
          current.provider = null
          current.sessionID = null
          void syncSynergyLink(null).catch((err) => log.warn("syncSynergyLink failed", { error: err }))
          setStatus(current, { status: "disconnected" })
          scheduleReconnect({ attempt: 0, reason })
        },
      })
    } catch (err) {
      current.provider = null
      throw err
    }

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
    // Settle provider before nulling — emits disconnected, settles all pending
    const provider = current.provider
    if (provider) {
      provider.settle()
    }
    current.provider = null
    current.sessionID = null
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
  }
  private pending: Map<string, UnifiedPending> = new Map()
  private connectedGen: ProviderGeneration = { emitted: false, sessionID: null }
  private disconnectEmitted = false

  constructor(private connection: RuntimeConnection) {}

  get peerId() {
    return this.state.peerId
  }

  private isCurrent(): boolean {
    return this.connection.provider === this
  }

  /**
   * Settle this provider cleanly: emit disconnected if connected,
   * settle all pending, and clean socket state.
   * Idempotent — safe to call multiple times.
   */
  settle(): void {
    if (this.connectedGen.emitted && !this.disconnectEmitted) {
      this.disconnectEmitted = true
      const ev: HolosConnectionEvent = {
        type: "disconnected",
        agentID: this.state.peerId ?? "unknown",
        sessionID: this.connectedGen.sessionID,
        generation: this.connection.generation,
        epoch: this.connection.epoch,
      }
      this.dispatchConnectionEvent(ev).catch(() => {})
    }
    for (const id of this.pending.keys()) this.takeAndReject(id)
    if (this.state.heartbeatTimer) {
      clearInterval(this.state.heartbeatTimer)
      this.state.heartbeatTimer = null
    }
    if (this.state.ws) {
      if (this.state.ws.readyState === WebSocket.OPEN || this.state.ws.readyState === WebSocket.CONNECTING) {
        this.state.ws.close()
      }
      this.state.ws = null
    }
    this.state.peerId = null
    this.connectedGen = { emitted: false, sessionID: null }
  }

  async connect(input: ConnectInput): Promise<void> {
    const { config: holosConfig, signal, onDisconnect } = input
    this.holosConfig = holosConfig
    this.connectedGen = { emitted: false, sessionID: null }
    this.disconnectEmitted = false

    let capturedScope: Scope
    try {
      capturedScope = ScopeContext.current.scope
    } catch {
      log.warn("ScopeContext.current.scope unavailable during connect, falling back to home scope")
      capturedScope = Scope.home()
    }

    const credentials = await HolosAuth.getCredentialOrThrow()
    const validatedWs = validateHolosEndpoint(holosConfig.wsUrl, "ws")
    const wsToken = await fetchWsToken(holosConfig.apiUrl, credentials.agentSecret, signal)
    const wsEndpoint = new URL(
      `/api/v1/holos/agent_tunnel/ws?token=${encodeURIComponent(wsToken)}`,
      validatedWs,
    ).toString()
    let ws: WebSocket
    try {
      ws = new WebSocket(wsEndpoint)
    } catch {
      throw new Error("WebSocket connection failed")
    }

    this.state = {
      ws,
      peerId: credentials.agentId,
      heartbeatTimer: null,
    }

    return new Promise<void>((resolve, reject) => {
      let opened = false
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        if (this.state.heartbeatTimer) clearInterval(this.state.heartbeatTimer)
        for (const p of this.pending.values()) {
          if (p.kind === "ws_send") clearTimeout(p.timer)
          else {
            if (p.timer) clearTimeout(p.timer)
            if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener)
          }
        }
        this.pending.clear()
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
        this.state.ws = null
        this.state.peerId = null
      }

      signal.addEventListener(
        "abort",
        () => {
          cleanup()
          if (!opened) reject(new Error("aborted"))
        },
        { once: true },
      )

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
            fn: () => this.handleParsedMessage(parsed, ws),
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

      ws.addEventListener("close", (event) => {
        const ce = event as CloseEvent
        if (!this.isCurrent() || ws !== this.state.ws) {
          // Stale socket: settle pending without publishing lifecycle
          for (const id of this.pending.keys()) this.takeAndReject(id)
          return
        }
        for (const id of this.pending.keys()) this.takeAndReject(id)
        if (this.connectedGen.emitted && !this.disconnectEmitted) {
          this.disconnectEmitted = true
          const ev: HolosConnectionEvent = {
            type: "disconnected",
            agentID: this.state.peerId ?? "unknown",
            sessionID: this.connectedGen.sessionID,
            generation: this.connection.generation,
            epoch: this.connection.epoch,
            code: ce.code,
            reason: typeof ce.reason === "string" ? ce.reason.slice(0, 200) : undefined,
          }
          this.dispatchConnectionEvent(ev).catch(() => {})
        }
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

      ws.addEventListener("error", () => {
        log.error("websocket transport error")
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
    const requestId = crypto.randomUUID()

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ sent: false, reason: "timeout" })
      }, WS_FAILED_TIMEOUT_MS)
      this.pending.set(requestId, { kind: "ws_send", timer, resolve, targetAgentId })

      try {
        this.state.ws!.send(Envelope.wsSend({ targetAgentId, event, payload, requestId }))
      } catch {
        this.pending.delete(requestId)
        clearTimeout(timer)
        resolve({ sent: false, reason: "transport_error" })
      }
    })
  }

  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: string
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): { response: Promise<NativeMessage>; requestID: string } {
    if (!this.isCurrent() || !this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) {
      throw {
        disposition: "not_dispatched" as const,
        requestID: input.requestID,
        code: "NOT_CONNECTED",
        message: "Holos Agent Tunnel is not connected",
      }
    }
    if (this.pending.has(input.requestID)) {
      throw {
        disposition: "not_dispatched" as const,
        requestID: input.requestID,
        code: "DUPLICATE_REQUEST_ID",
        message: `Duplicate in-flight request ID: ${input.requestID}`,
      }
    }
    if (input.signal?.aborted) {
      throw {
        disposition: "not_dispatched" as const,
        requestID: input.requestID,
        code: "ABORTED",
        message: "Request aborted before dispatch",
      }
    }

    let resolveResponse!: (message: NativeMessage) => void
    let rejectResponse!: (failure: NativeRequestFailure) => void
    const response = new Promise<NativeMessage>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    const pending: Extract<UnifiedPending, { kind: "native_request" }> = {
      kind: "native_request",
      resolve: resolveResponse,
      reject: rejectResponse,
      timer: null,
      expectedResponseType: input.expectedResponseType,
      signal: input.signal,
    }
    if (input.signal) {
      pending.abortListener = () => {
        const current = this.takePending(input.requestID)
        if (current?.kind === "native_request") {
          current.reject({
            disposition: "ambiguous",
            requestID: input.requestID,
            reason: "aborted_after_dispatch",
            message: "Request aborted after dispatch",
          })
        }
      }
      input.signal.addEventListener("abort", pending.abortListener, { once: true })
    }
    const timeoutMs = clampNativeRequestTimeout(DEFAULT_REQUEST_TIMEOUT_MS, input.timeoutMs)
    pending.timer = setTimeout(() => {
      const current = this.takePending(input.requestID)
      if (current?.kind === "native_request") {
        current.reject({
          disposition: "ambiguous",
          requestID: input.requestID,
          reason: "timeout",
          message: `Request timed out after ${timeoutMs}ms`,
        })
      }
    }, timeoutMs)
    this.pending.set(input.requestID, pending)
    try {
      this.writeNative({
        type: input.type,
        payload: input.payload,
        requestID: input.requestID,
        meta: input.meta ?? {},
      })
    } catch (error) {
      this.takePending(input.requestID)
      throw {
        disposition: "not_dispatched" as const,
        requestID: input.requestID,
        code: "TRANSPORT_ERROR",
        message: error instanceof Error ? error.message : "Native request dispatch failed",
      }
    }
    return { response, requestID: input.requestID }
  }

  private writeNative(input: {
    type: string
    payload: unknown
    requestID: string
    meta?: Record<string, unknown>
  }): void {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected")
    this.state.ws.send(
      Envelope.native({
        type: input.type,
        requestID: input.requestID,
        meta: input.meta ?? {},
        payload: input.payload,
        caller: null,
      }),
    )
  }

  private takePending(requestID: string): UnifiedPending | undefined {
    const p = this.pending.get(requestID)
    if (!p) return undefined
    this.pending.delete(requestID)
    if (p.kind === "native_request") {
      if (p.timer) clearTimeout(p.timer)
      if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener)
    }
    return p
  }

  private takeAndReject(id: string): void {
    const p = this.takePending(id)
    if (!p) return
    if (p.kind === "ws_send") {
      clearTimeout(p.timer)
      p.resolve({ sent: false, reason: "disconnected" })
    } else {
      p.reject({ disposition: "ambiguous", requestID: id, reason: "disconnected", message: "Disconnected" })
    }
  }

  private async handleParsedMessage(msg: Envelope.Parsed, sourceWS: WebSocket): Promise<void> {
    if (!this.isCurrent() || sourceWS !== this.state.ws) return
    switch (msg.kind) {
      case "connected": {
        if (!this.connectedGen.emitted) {
          const sessionID = msg.sessionId
          this.connection.generation++
          this.connection.sessionID = sessionID
          this.connectedGen = { emitted: true, sessionID: sessionID || null }
          const event: HolosConnectionEvent = {
            type: "connected",
            agentID: this.state.peerId ?? "unknown",
            sessionID,
            generation: this.connection.generation,
            epoch: this.connection.epoch,
          }
          this.dispatchConnectionEvent(event).catch((error) =>
            log.warn("connected observer failed", { error: String(error) }),
          )
        }
        return
      }
      case "pong":
      case "unknown":
        return
      case "error":
        if (msg.requestId) {
          const p = this.pending.get(msg.requestId)
          if (p) {
            if (p.kind === "native_request") {
              this.takePending(msg.requestId)
              p.reject({ disposition: "rejected", requestID: msg.requestId, code: msg.code, message: msg.message })
            } else {
              clearTimeout(p.timer)
              this.pending.delete(msg.requestId)
              p.resolve({ sent: false, reason: "delivery_failed" })
            }
            return
          }
        }
        log.warn("unmatched error", { code: msg.code })
        return
      case "ws_failed":
        this.handleWsFailed(msg)
        return
      case "ws_send":
        Presence.markOnline(msg.caller.agent_id)
        this.handleAppEvent(msg.event, msg.payload, msg.caller)
        return
      case "native": {
        const nm: NativeMessage = {
          type: msg.type,
          requestID: msg.requestID,
          meta: msg.meta,
          payload: msg.payload,
          caller: msg.caller,
          agentID: this.state.peerId ?? "unknown",
          sessionID: this.connection.sessionID,
          generation: this.connection.generation,
          epoch: this.connection.epoch,
        }
        if (msg.requestID) {
          const pending = this.pending.get(msg.requestID)
          if (pending && pending.kind === "native_request") {
            if (msg.type === pending.expectedResponseType) {
              const s = this.takePending(msg.requestID)
              if (s && s.kind === "native_request") s.resolve(nm)
            } else {
              const u = this.takePending(msg.requestID)
              if (u && u.kind === "native_request")
                u.reject({
                  disposition: "ambiguous",
                  requestID: msg.requestID,
                  reason: "unexpected_response",
                  message: `Expected ${pending.expectedResponseType}, got ${msg.type}`,
                })
            }
          }
        }
        this.dispatchToNativeObservers(nm).catch((err) =>
          log.warn("native observer failed", { type: nm.type, error: String(err) }),
        )
        return
      }
      default:
        return
    }
  }

  private handleWsFailed(msg: Extract<Envelope.Parsed, { kind: "ws_failed" }>): void {
    const pending = this.pending.get(msg.requestId)
    if (!pending || pending.kind !== "ws_send") return
    clearTimeout(pending.timer)
    this.pending.delete(msg.requestId)
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
    if (!this.state.peerId || caller.agent_id === this.state.peerId) return

    const parsed = HolosProtocol.ChatMessagePayload.safeParse(payload)
    if (!parsed.success) return

    const contact = await Contact.get(caller.agent_id)
    if (contact?.blocked) {
      log.info("message blocked", { from: caller.agent_id })
      return
    }

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

  private async dispatchConnectionEvent(event: HolosConnectionEvent): Promise<void> {
    for (const o of this.connection.connectionObservers) {
      try {
        await o(event)
      } catch {
        // observer errors are silently dropped
      }
    }
  }

  private async dispatchToNativeObservers(msg: NativeMessage): Promise<void> {
    for (const o of this.connection.nativeObservers) {
      try {
        await o(msg)
      } catch {
        // observer errors are silently dropped
      }
    }
  }
}
