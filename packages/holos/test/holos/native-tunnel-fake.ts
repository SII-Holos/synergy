import type {
  HolosConnectionEvent,
  NativeMessage,
  NativeRequestFailure,
  NativeTunnelPort,
  RequestID,
} from "../../src/holos/native"
import {
  NATIVE_FRAME_SIZE_LIMIT,
  NATIVE_MAX_ARRAY_LENGTH,
  NATIVE_MAX_ID_LENGTH,
  NATIVE_MAX_OBJECT_DEPTH,
  NATIVE_MAX_OBJECT_KEYS,
  NATIVE_MAX_PAYLOAD_BYTES,
  NATIVE_MAX_STRING_LENGTH,
} from "../../src/holos/native"
import { Envelope } from "../../src/holos/envelope"

const textEncoder = new TextEncoder()

type PendingRequest = {
  type: string
  payload: unknown
  expectedResponseType: string
  resolve: (msg: NativeMessage) => void
  reject: (failure: NativeRequestFailure) => void
  timeout: ReturnType<typeof setTimeout> | null
  signal: AbortSignal | null
  meta?: Record<string, unknown>
  dispatched: boolean
}

export type FakeTunnelOptions = {
  agentID?: string
  sessionID?: string
  epoch?: number
  startGeneration?: number
}

export class FakeNativeTunnelPort implements NativeTunnelPort {
  private _generation: number
  private _epoch: number
  private _agentID: string
  private _sessionID: string | null

  private _nativeObservers = new Set<(msg: NativeMessage) => void | Promise<void>>()
  private _connectionObservers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  private _pendingRequests = new Map<RequestID, PendingRequest>()

  private _socketWrites: Array<{ type: string; payload: unknown; requestID: string; meta?: Record<string, unknown> }> =
    []
  private _closed = false
  private _closedCode: number | undefined
  private _closedReason: string | undefined

  constructor(options: FakeTunnelOptions = {}) {
    this._agentID = options.agentID ?? "agent-test"
    this._sessionID = options.sessionID ?? null
    this._epoch = options.epoch ?? 1
    this._generation = options.startGeneration ?? 1
  }

  get generation(): number {
    return this._generation
  }

  get epoch(): number {
    return this._epoch
  }

  get agentID(): string {
    return this._agentID
  }

  get sessionID(): string | null {
    return this._sessionID
  }

  get socketWrites(): ReadonlyArray<{
    type: string
    payload: unknown
    requestID: string
    meta?: Record<string, unknown>
  }> {
    return this._socketWrites
  }

  get isClosed(): boolean {
    return this._closed
  }

  get closedCode(): number | undefined {
    return this._closedCode
  }

  get closedReason(): string | undefined {
    return this._closedReason
  }

  get pendingRequestCount(): number {
    return this._pendingRequests.size
  }

  get nativeObserverCount(): number {
    return this._nativeObservers.size
  }

  get connectionObserverCount(): number {
    return this._connectionObservers.size
  }

  simulateConnected(
    input: {
      agentID?: string
      sessionID?: string
      epoch?: number
    } = {},
  ): void {
    if (input.agentID !== undefined) this._agentID = input.agentID
    if (input.sessionID !== undefined) this._sessionID = input.sessionID
    if (input.epoch !== undefined) this._epoch = input.epoch
    this._generation++
    this._closed = false
    this._closedCode = undefined
    this._closedReason = undefined

    const event: HolosConnectionEvent = {
      type: "connected",
      agentID: this._agentID,
      sessionID: this._sessionID!,
      generation: this._generation,
      epoch: this._epoch,
    }
    this._notifyConnectionObservers(event)
  }

  simulateDisconnected(
    input: {
      code?: number
      reason?: string
      agentID?: string
      sessionID?: string | null
      generation?: number
      epoch?: number
    } = {},
  ): void {
    this._closed = true
    this._closedCode = input.code ?? 1000
    this._closedReason = input.reason ?? "simulated close"

    const generation = input.generation ?? this._generation
    const event: HolosConnectionEvent = {
      type: "disconnected",
      agentID: input.agentID ?? this._agentID,
      sessionID: input.sessionID !== undefined ? input.sessionID : this._sessionID,
      generation,
      epoch: input.epoch ?? this._epoch,
      code: this._closedCode,
      reason: this._closedReason,
    }

    if (input.generation === undefined || input.generation === generation) {
      this._settleAllPending({
        disposition: "ambiguous",
        reason: "disconnected",
        message: `Tunnel disconnected: ${this._closedReason}`,
      })
    }

    this._notifyConnectionObservers(event)
  }

  simulateProviderReplacement(input: { agentID?: string; sessionID?: string } = {}): void {
    if (input.agentID !== undefined) this._agentID = input.agentID
    if (input.sessionID !== undefined) this._sessionID = input.sessionID
    this._generation++

    const event: HolosConnectionEvent = {
      type: "connected",
      agentID: this._agentID,
      sessionID: this._sessionID!,
      generation: this._generation,
      epoch: this._epoch,
    }
    this._notifyConnectionObservers(event)
  }

  simulateStop(): void {
    this._closed = true
    this._closedCode = 1000
    this._closedReason = "tunnel stopped"
    this._settleAllPending({
      disposition: "ambiguous",
      reason: "disconnected",
      message: "Tunnel stopped",
    })
  }

  private _settleAllPending(
    template: Omit<Extract<NativeRequestFailure, { disposition: "ambiguous" }>, "requestID">,
  ): void {
    for (const [requestID, pending] of this._pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject({ ...template, requestID } satisfies NativeRequestFailure)
    }
    this._pendingRequests.clear()
  }

  injectResponse(msg: NativeMessage): void {
    for (const observer of this._nativeObservers) {
      observer(msg)
    }
  }

  injectResponseForRequest(requestID: RequestID, response: NativeMessage): void {
    const pending = this._pendingRequests.get(requestID)
    if (!pending) return
    if (pending.timeout) clearTimeout(pending.timeout)
    this._pendingRequests.delete(requestID)
    pending.resolve(response)
  }

  injectConnectionEvent(event: HolosConnectionEvent): void {
    this._notifyConnectionObservers(event)
  }

  simulateNativeMessage(msg: NativeMessage): void {
    for (const observer of this._nativeObservers) {
      observer(msg)
    }
  }

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

  sendNativeRequest(input: {
    type: string
    payload: unknown
    requestID: RequestID
    expectedResponseType: string
    timeoutMs?: number
    signal?: AbortSignal
    meta?: Record<string, unknown>
  }): { response: Promise<NativeMessage>; requestID: RequestID } {
    const { type, payload, requestID, timeoutMs, signal, meta } = input

    if (!type || type.length === 0) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "INVALID_TYPE",
          message: "type must not be empty",
        } satisfies NativeRequestFailure),
      }
    }
    if (type.length > NATIVE_MAX_ID_LENGTH) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "INVALID_TYPE",
          message: `Type exceeds ${NATIVE_MAX_ID_LENGTH} chars`,
        } satisfies NativeRequestFailure),
      }
    }

    let serialized: string
    try {
      serialized = JSON.stringify(payload)
    } catch {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "INVALID_PAYLOAD",
          message: "Payload cannot be serialized (may contain circular references)",
        } satisfies NativeRequestFailure),
      }
    }
    if (textEncoder.encode(serialized).byteLength > NATIVE_MAX_PAYLOAD_BYTES) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "PAYLOAD_TOO_LARGE",
          message: `Payload exceeds ${NATIVE_MAX_PAYLOAD_BYTES} bytes`,
        } satisfies NativeRequestFailure),
      }
    }

    let frame: string
    try {
      frame = Envelope.nativeRequest({ requestID, nativeType: type, payload, meta })
    } catch {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "INVALID_PAYLOAD",
          message: "Native frame cannot be serialized",
        } satisfies NativeRequestFailure),
      }
    }
    if (textEncoder.encode(frame).byteLength > NATIVE_FRAME_SIZE_LIMIT) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "FRAME_TOO_LARGE",
          message: `Frame exceeds ${NATIVE_FRAME_SIZE_LIMIT} bytes`,
        } satisfies NativeRequestFailure),
      }
    }

    if (!validateDepth(payload)) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "rejected",
          requestID,
          code: "INVALID_PAYLOAD",
          message: `Payload exceeds max object depth`,
        } satisfies NativeRequestFailure),
      }
    }

    if (this._closed) {
      return {
        requestID,
        response: Promise.reject({
          disposition: "not_dispatched",
          requestID,
          code: "NOT_CONNECTED",
          message: "Tunnel is not connected",
        } satisfies NativeRequestFailure),
      }
    }

    this._socketWrites.push({ type, payload, requestID, meta })

    const response = new Promise<NativeMessage>((resolve, reject) => {
      if (signal?.aborted) {
        reject({
          disposition: "ambiguous",
          requestID,
          reason: "aborted_after_dispatch",
          message: "Request aborted after dispatch",
        } satisfies NativeRequestFailure)
        return
      }

      let timeout: ReturnType<typeof setTimeout> | null = null

      const pending: PendingRequest = {
        type,
        payload,
        expectedResponseType: input.expectedResponseType,
        resolve,
        reject,
        timeout: null,
        signal: signal ?? null,
        meta,
        dispatched: true,
      }

      if (signal) {
        const abortHandler = () => {
          if (pending.timeout) clearTimeout(pending.timeout)
          this._pendingRequests.delete(requestID)
          reject({
            disposition: "ambiguous",
            requestID,
            reason: "aborted_after_dispatch",
            message: "Request aborted after dispatch",
          } satisfies NativeRequestFailure)
        }
        signal.addEventListener("abort", abortHandler, { once: true })
      }

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (this._pendingRequests.has(requestID)) {
            this._pendingRequests.delete(requestID)
            reject({
              disposition: "ambiguous",
              requestID,
              reason: "timeout",
              message: `Request timed out after ${timeoutMs}ms`,
            } satisfies NativeRequestFailure)
          }
        }, timeoutMs)
      }

      pending.timeout = timeout
      this._pendingRequests.set(requestID, pending)
    })

    return { requestID, response }
  }

  getPendingRequest(requestID: RequestID): PendingRequest | undefined {
    return this._pendingRequests.get(requestID)
  }

  private _notifyConnectionObservers(event: HolosConnectionEvent): void {
    for (const observer of this._connectionObservers) {
      observer(event)
    }
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
