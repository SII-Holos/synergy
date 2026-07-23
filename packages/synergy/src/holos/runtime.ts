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
import type { HolosConnectionEvent, NativeMessage, NativeRequestFailure, NativeTunnelPort, RequestID } from "./native"
import {
  NATIVE_FRAME_SIZE_LIMIT,
  NATIVE_MAX_ID_LENGTH,
  NATIVE_MAX_OBJECT_DEPTH,
  NATIVE_MAX_PAYLOAD_BYTES,
} from "./native"

const log = Log.create({ service: "holos.runtime" })
const HEARTBEAT_INTERVAL_MS = 30_000
const WS_FAILED_TIMEOUT_MS = 1_500
const RECONNECT_DELAY_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 50
const textEncoder = new TextEncoder()

type PendingSend = {
  timer: ReturnType<typeof setTimeout>
  resolve: (result: { sent: boolean; reason?: string }) => void
  targetAgentId: string
}

type PendingNativeRequest = {
  requestID: string
  expectedResponseType: string
  resolve: (msg: NativeMessage) => void
  reject: (failure: NativeRequestFailure) => void
  timeout: ReturnType<typeof setTimeout> | null
  abortListener: (() => void) | null
}

type ConnectionState = {
  ws: WebSocket | null
  peerId: string | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  pendingSends: Map<string, PendingSend>
  pendingNativeRequests: Map<string, PendingNativeRequest>
}

type RuntimeConnection = {
  holosConfig: Config.Holos | null
  abort: AbortController
  status: HolosRuntime.Status
  provider: HolosProvider | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  generation: number
  sessionID: string | null
  agentID: string | null
  epoch: number
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
      generation: 0,
      sessionID: null,
      agentID: null,
      epoch: Date.now(),
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

  let nativeTunnelPort: NativeTunnelPortImpl | null = null

  export async function getNativeTunnel(): Promise<NativeTunnelPort> {
    if (!nativeTunnelPort) {
      nativeTunnelPort = new NativeTunnelPortImpl()
    }
    return nativeTunnelPort
  }

  export async function getNativeIdentity(): Promise<{
    agentID: string | null
    sessionID: string | null
    generation: number
    epoch: number
  }> {
    const current = await state()
    return {
      agentID: current.agentID,
      sessionID: current.sessionID,
      generation: current.generation,
      epoch: current.epoch,
    }
  }

  export async function getNativeIdentityFor(provider: HolosProvider): Promise<{
    agentID: string
    sessionID: string | null
    generation: number
    epoch: number
  } | null> {
    const current = await state()
    if (current.provider !== provider || current.status.status !== "connected" || !current.agentID) return null
    return {
      agentID: current.agentID,
      sessionID: current.sessionID,
      generation: current.generation,
      epoch: current.epoch,
    }
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
    current.abort.abort()
    current.abort = new AbortController()
    current.holosConfig = holos ?? null
    current.provider = null
    current.generation = 0
    current.sessionID = null
    current.agentID = null
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
        const disconnectedGen = current.generation
        const disconnectEvent: HolosConnectionEvent = {
          type: "disconnected",
          agentID: current.agentID ?? "",
          sessionID: current.sessionID,
          generation: disconnectedGen,
          epoch: current.epoch,
          code: 1000,
          reason: reason ?? "ws_closed",
        }
        current.provider = null
        current.sessionID = null
        void syncSynergyLink(null).catch((err) => log.warn("syncSynergyLink failed", { error: err }))
        setStatus(current, { status: "disconnected" })
        scheduleReconnect({ attempt: 0, reason })
        if (nativeTunnelPort) {
          nativeTunnelPort.notifyConnectionObservers(disconnectEvent)
        }
      },
    })

    if (signal.aborted) return

    current.generation++
    current.provider = provider
    current.sessionID = provider.peerId ? `session-${Date.now()}` : null
    current.agentID = provider.peerId
    setStatus(current, { status: "connected" })
    await syncSynergyLink({ provider })

    if (nativeTunnelPort) {
      nativeTunnelPort.notifyConnectionObservers({
        type: "connected",
        agentID: current.agentID ?? "",
        sessionID: current.sessionID ?? "",
        generation: current.generation,
        epoch: current.epoch,
      })
    }
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
    if (nativeTunnelPort) {
      nativeTunnelPort.notifyConnectionObservers({
        type: "disconnected",
        agentID: current.agentID ?? "",
        sessionID: current.sessionID,
        generation: current.generation,
        epoch: current.epoch,
        code: 1000,
        reason: "tunnel stopped",
      })
    }
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

function validateDepth(value: unknown, depth = NATIVE_MAX_OBJECT_DEPTH): boolean {
  if (depth <= 0) return false
  if (value == null || typeof value !== "object") return true
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "object" && item !== null && !validateDepth(item, depth - 1)) return false
    }
    return true
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && !validateDepth(v, depth - 1)) return false
  }
  return true
}

function rejectImmediate(
  requestID: RequestID,
  template: { disposition: "rejected"; code: string; message: string },
): { response: Promise<NativeMessage>; requestID: RequestID } {
  return {
    requestID,
    response: Promise.reject({ ...template, requestID } satisfies NativeRequestFailure),
  }
}

class NativeTunnelPortImpl implements NativeTunnelPort {
  private _nativeObservers = new Set<(msg: NativeMessage) => void | Promise<void>>()
  private _connectionObservers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()

  registerNativeObserver(handler: (msg: NativeMessage) => void | Promise<void>): () => void {
    this._nativeObservers.add(handler)
    return () => {
      this._nativeObservers.delete(handler)
    }
  }

  registerConnectionObserver(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this._connectionObservers.add(handler)
    return () => {
      this._connectionObservers.delete(handler)
    }
  }

  notifyNativeObservers(msg: NativeMessage): void {
    for (const observer of this._nativeObservers) {
      try {
        Promise.resolve(observer(msg)).catch((error) => log.warn("native observer failed", { error }))
      } catch (error) {
        log.warn("native observer failed", { error })
      }
    }
  }

  notifyConnectionObservers(event: HolosConnectionEvent): void {
    for (const observer of this._connectionObservers) {
      try {
        Promise.resolve(observer(event)).catch((error) => log.warn("connection observer failed", { error }))
      } catch (error) {
        log.warn("connection observer failed", { error })
      }
    }
  }

  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: RequestID
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): { response: Promise<NativeMessage>; requestID: RequestID } {
    const { type, payload, requestID, expectedResponseType, timeoutMs, signal, meta } = input

    if (!type || type.length === 0) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "INVALID_TYPE",
        message: "type must not be empty",
      })
    }
    if (type.length > NATIVE_MAX_ID_LENGTH) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "INVALID_TYPE",
        message: `Type exceeds ${NATIVE_MAX_ID_LENGTH} chars`,
      })
    }

    let serializedPayload: string
    try {
      serializedPayload = JSON.stringify(payload)
    } catch {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "INVALID_PAYLOAD",
        message: "Payload cannot be serialized (may contain circular references)",
      })
    }
    if (textEncoder.encode(serializedPayload).byteLength > NATIVE_MAX_PAYLOAD_BYTES) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "PAYLOAD_TOO_LARGE",
        message: `Payload exceeds ${NATIVE_MAX_PAYLOAD_BYTES} bytes`,
      })
    }

    let frame: string
    try {
      frame = Envelope.nativeRequest({ requestID, nativeType: type, payload, meta })
    } catch {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "INVALID_PAYLOAD",
        message: "Native frame cannot be serialized",
      })
    }
    if (textEncoder.encode(frame).byteLength > NATIVE_FRAME_SIZE_LIMIT) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "FRAME_TOO_LARGE",
        message: `Frame exceeds ${NATIVE_FRAME_SIZE_LIMIT} bytes`,
      })
    }

    if (!validateDepth(payload)) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "INVALID_PAYLOAD",
        message: "Payload exceeds max object depth",
      })
    }

    if (signal?.aborted) {
      return rejectImmediate(requestID, {
        disposition: "rejected",
        code: "ABORTED_BEFORE_DISPATCH",
        message: "Request aborted before dispatch",
      })
    }

    const response = HolosRuntime.getProvider().then((provider) => {
      if (!provider) {
        throw {
          disposition: "not_dispatched",
          requestID,
          code: "NOT_CONNECTED",
          message: "Tunnel is not connected",
        } satisfies NativeRequestFailure
      }
      return provider.sendNativeRequest({ type, payload, requestID, expectedResponseType, timeoutMs, signal, meta })
    })

    return { response, requestID }
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
    pendingNativeRequests: new Map(),
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
      pendingNativeRequests: new Map(),
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
        this.settleNativePending("disconnected", "Tunnel disconnected")
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

  async sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: string
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): Promise<NativeMessage> {
    const ws = this.state.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw {
        disposition: "not_dispatched",
        requestID: input.requestID,
        code: "NOT_CONNECTED",
        message: "Tunnel is not connected",
      } satisfies NativeRequestFailure
    }
    if (this.state.pendingNativeRequests.has(input.requestID)) {
      throw {
        disposition: "rejected",
        requestID: input.requestID,
        code: "DUPLICATE_REQUEST_ID",
        message: "A native request with this request ID is already pending",
      } satisfies NativeRequestFailure
    }
    if (input.signal?.aborted) {
      throw {
        disposition: "rejected",
        requestID: input.requestID,
        code: "ABORTED_BEFORE_DISPATCH",
        message: "Request aborted before dispatch",
      } satisfies NativeRequestFailure
    }

    const frame = Envelope.nativeRequest({
      requestID: input.requestID,
      nativeType: input.type,
      payload: input.payload,
      meta: input.meta,
    })
    if (textEncoder.encode(frame).byteLength > NATIVE_FRAME_SIZE_LIMIT) {
      throw {
        disposition: "rejected",
        requestID: input.requestID,
        code: "FRAME_TOO_LARGE",
        message: `Frame exceeds ${NATIVE_FRAME_SIZE_LIMIT} bytes`,
      } satisfies NativeRequestFailure
    }

    return new Promise<NativeMessage>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      let abortListener: (() => void) | null = null
      const settleOnce = () => {
        if (settled) return false
        settled = true
        if (timeout) clearTimeout(timeout)
        if (abortListener) input.signal?.removeEventListener("abort", abortListener)
        this.state.pendingNativeRequests.delete(input.requestID)
        return true
      }

      const pending: PendingNativeRequest = {
        requestID: input.requestID,
        expectedResponseType: input.expectedResponseType,
        resolve: (msg) => {
          if (!settleOnce()) return
          resolve(msg)
        },
        reject: (failure) => {
          if (!settleOnce()) return
          reject(failure)
        },
        timeout: null,
        abortListener: null,
      }

      if (input.timeoutMs && input.timeoutMs > 0) {
        timeout = setTimeout(() => {
          pending.reject({
            disposition: "ambiguous",
            requestID: input.requestID,
            reason: "timeout",
            message: `Request timed out after ${input.timeoutMs}ms`,
          })
        }, input.timeoutMs)
        pending.timeout = timeout
      }
      if (input.signal) {
        abortListener = () => {
          pending.reject({
            disposition: "ambiguous",
            requestID: input.requestID,
            reason: "aborted_after_dispatch",
            message: "Request aborted after dispatch",
          })
        }
        pending.abortListener = abortListener
        input.signal.addEventListener("abort", abortListener, { once: true })
      }

      this.state.pendingNativeRequests.set(input.requestID, pending)
      try {
        ws.send(frame)
      } catch (error) {
        pending.reject({
          disposition: "not_dispatched",
          requestID: input.requestID,
          code: "SEND_FAILED",
          message: error instanceof Error ? error.message : "Failed to write native request",
        })
      }
    })
  }

  private settleNativePending(reason: "disconnected" | "timeout" | "aborted_after_dispatch", message: string): void {
    for (const [requestID, pending] of this.state.pendingNativeRequests) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject({
        disposition: "ambiguous",
        requestID,
        reason,
        message,
      })
    }
    this.state.pendingNativeRequests.clear()
  }

  private handleParsedMessage(msg: Envelope.Parsed): void {
    switch (msg.kind) {
      case "pong":
        break
      case "error":
        this.handleGatewayError(msg)
        break
      case "ws_failed":
        this.handleWsFailed(msg)
        break
      case "ws_send":
        Presence.markOnline(msg.caller.agent_id)
        this.handleAppEvent(msg.event, msg.payload, msg.caller)
        break
      case "native":
        void this.handleNativeMessage(msg)
        break
    }
  }

  private async handleNativeMessage(msg: Extract<Envelope.Parsed, { kind: "native" }>): Promise<void> {
    const identity = await HolosRuntime.getNativeIdentityFor(this)
    if (!identity) {
      log.warn("native message dropped: no matching provider identity")
      return
    }
    const nativeMsg: NativeMessage = {
      type: msg.nativeType,
      requestID: msg.requestId,
      meta: msg.meta,
      payload: msg.payload,
      caller: msg.caller,
      agentID: identity.agentID,
      sessionID: identity.sessionID,
      generation: identity.generation,
      epoch: identity.epoch,
    }

    if (msg.requestId) {
      const pending = this.state.pendingNativeRequests.get(msg.requestId)
      if (pending) {
        if (pending.expectedResponseType && msg.nativeType !== pending.expectedResponseType) {
          pending.reject({
            disposition: "ambiguous",
            requestID: msg.requestId,
            reason: "unexpected_response",
            message: `Expected response type "${pending.expectedResponseType}" but got "${msg.nativeType}"`,
          })
        } else {
          pending.resolve(nativeMsg)
        }
      }
    }

    const port = await HolosRuntime.getNativeTunnel()
    ;(port as NativeTunnelPortImpl).notifyNativeObservers(nativeMsg)
  }

  private handleGatewayError(msg: Extract<Envelope.Parsed, { kind: "error" }>): void {
    if (msg.requestId) {
      const pending = this.state.pendingNativeRequests.get(msg.requestId)
      if (pending) {
        pending.reject({
          disposition: "rejected",
          requestID: msg.requestId,
          code: msg.code,
          message: msg.message,
        })
        return
      }
    }
    log.warn("uncorrelated gateway error", { code: msg.code.slice(0, 256), message: msg.message.slice(0, 256) })
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
}
