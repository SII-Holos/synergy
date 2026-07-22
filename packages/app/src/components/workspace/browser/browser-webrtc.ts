import {
  BROWSER_PROTOCOL_VERSION,
  BrowserRemoteInputSchema,
  BrowserWebRTCMessageSchema,
  BrowserWebRTCSignalSchema,
  type BrowserWebRTCSignal,
} from "@ericsanchezok/synergy-browser"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

type BrowserWebRTCSignalingUrlOptions = {
  serverUrl: string
  sessionID: string
  pageId?: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  ticket?: string
  traceId?: string
}

export function createBrowserWebRTCSignalingUrl(options: BrowserWebRTCSignalingUrlOptions) {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) return null

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: "webrtc",
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.ticket) params.set("ticket", options.ticket)
  if (options.pageId) params.set("pageId", options.pageId)
  if (options.traceId) params.set("traceId", options.traceId)

  return (
    options.serverUrl.replace(/^http/, "ws") +
    `/${encodeURIComponent(pathDirectory)}/browser/webrtc/connect?${params.toString()}`
  )
}

export type BrowserWebRTCStatus =
  | "idle"
  | "signaling"
  | "host_pending"
  | "host_ready"
  | "negotiating"
  | "stream_ready"
  | "closed"
  | "error"

export interface BrowserWebRTCClientOptions {
  signalingUrl: string | (() => Promise<{ url: string; rtcConfiguration?: RTCConfiguration }>)
  pageId: string
  rtcConfiguration?: RTCConfiguration
  traceId?: string
  onStatus?(status: BrowserWebRTCStatus, detail?: unknown): void
  onStream?(stream: MediaStream): void
  onMessage?(message: unknown): void
}

export class BrowserWebRTCClient {
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private input: RTCDataChannel | null = null
  private closed = false
  private retryStopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private negotiating: Promise<void> | null = null
  private readonly connectionId = generateUUID()
  private generation = 0
  private signalingAttempt = 0
  private iceSequence = 0
  private rtcConfiguration: RTCConfiguration | undefined

  constructor(private options: BrowserWebRTCClientOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Browser WebRTC client is closed")
    this.retryStopped = false
    this.options.onStatus?.("signaling")

    this.connectSignaling()
  }

  sendInput(payload: unknown): boolean {
    if (this.input?.readyState !== "open") return false
    const candidate =
      payload && typeof payload === "object" ? { ...payload, protocolVersion: BROWSER_PROTOCOL_VERSION } : payload
    const parsed = BrowserRemoteInputSchema.safeParse(candidate)
    if (!parsed.success || parsed.data.pageId !== this.options.pageId) return false
    this.input.send(JSON.stringify(parsed.data))
    return true
  }

  close(): void {
    this.closed = true
    this.signalingAttempt++
    this.clearReconnectTimer()
    this.sendSignal({
      type: "webrtc.close",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      generation: this.generation,
      pageId: this.options.pageId,
    })
    this.closePeer()
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  private createPeer(): RTCPeerConnection {
    if (this.pc) return this.pc
    const pc = new RTCPeerConnection(this.rtcConfiguration ?? this.options.rtcConfiguration)
    this.pc = pc
    pc.addTransceiver("video", { direction: "recvonly" })
    this.input = pc.createDataChannel("browser-input", { ordered: true })

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.options.onStream?.(stream)
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      const candidate = event.candidate.toJSON()
      this.sendSignal({
        type: "webrtc.ice",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        connectionId: this.connectionId,
        generation: this.generation,
        sequence: this.iceSequence++,
        pageId: this.options.pageId,
        candidate: {
          candidate: candidate.candidate ?? event.candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        },
      })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.markStable()
        this.options.onStatus?.("stream_ready")
      }
      if (pc.connectionState === "failed") {
        this.options.onStatus?.("error", { connectionState: pc.connectionState })
        if (this.pc !== pc) return
        const ws = this.ws
        this.ws = null
        ws?.close()
        this.closePeer()
        this.scheduleReconnect()
      }
      if (pc.connectionState === "closed") this.options.onStatus?.("closed")
    }
    return pc
  }

  private connectSignaling(): void {
    if (this.closed) return
    this.clearReconnectTimer()
    const attempt = ++this.signalingAttempt
    this.options.onStatus?.("signaling")
    if (typeof this.options.signalingUrl === "string") {
      this.openSignaling(this.options.signalingUrl, attempt)
      return
    }
    void this.options
      .signalingUrl()
      .then((resolved) => {
        if (this.closed || attempt !== this.signalingAttempt) return
        this.rtcConfiguration = resolved.rtcConfiguration
        this.openSignaling(resolved.url, attempt)
      })
      .catch((error) => {
        if (this.closed || attempt !== this.signalingAttempt) return
        if (!isRetryable(error)) {
          this.retryStopped = true
          this.options.onStatus?.("error", error)
          return
        }
        this.options.onStatus?.("host_pending", error)
        this.scheduleReconnect()
      })
  }

  private openSignaling(url: string, attempt: number): void {
    if (this.closed || attempt !== this.signalingAttempt) return
    const previous = this.ws
    this.ws = null
    previous?.close()
    this.closePeer()
    this.createPeer()
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener("open", () => {
      if (this.closed || this.ws !== ws || attempt !== this.signalingAttempt) {
        ws.close()
        return
      }
      this.createPeer()
    })

    ws.addEventListener("message", (event) => {
      if (this.closed || this.ws !== ws || attempt !== this.signalingAttempt) return
      void this.handleSignal(event.data)
    })

    ws.addEventListener("close", () => {
      if (this.ws !== ws || attempt !== this.signalingAttempt) return
      this.ws = null
      this.closePeer()
      this.options.onStatus?.("closed")
      this.scheduleReconnect()
    })

    ws.addEventListener("error", (event) => {
      if (this.ws !== ws || attempt !== this.signalingAttempt) return
      this.options.onStatus?.("error", event)
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryStopped || this.reconnectTimer) return
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectSignaling()
    }, backoffDelay(this.reconnectAttempt))
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private markStable(): void {
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
  }

  private closePeer(): void {
    this.input?.close()
    this.pc?.close()
    this.input = null
    this.pc = null
  }

  private async negotiate(): Promise<void> {
    if (this.negotiating) return this.negotiating
    this.negotiating = this.negotiateOnce().finally(() => {
      this.negotiating = null
    })
    return this.negotiating
  }

  private async negotiateOnce(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    let pc = this.createPeer()
    if (this.needsFreshPeer(pc)) {
      this.closePeer()
      pc = this.createPeer()
    }
    this.options.onStatus?.("negotiating")
    this.generation++
    this.iceSequence = 0
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.sendSignal({
      type: "webrtc.offer",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      generation: this.generation,
      pageId: this.options.pageId,
      sdp: offer.sdp ?? "",
    })
  }

  private needsFreshPeer(pc: RTCPeerConnection): boolean {
    return (
      pc.signalingState !== "stable" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected" ||
      pc.connectionState === "closed"
    )
  }

  private async handleSignal(raw: unknown): Promise<void> {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      this.retryStopped = true
      this.options.onStatus?.("error", { message: "Invalid WebRTC signaling payload" })
      return
    }

    const parsedMessage = BrowserWebRTCMessageSchema.safeParse(msg)
    if (!parsedMessage.success) {
      this.retryStopped = true
      this.options.onStatus?.("error", { message: "Invalid Browser WebRTC protocol message." })
      return
    }
    const message = parsedMessage.data
    this.options.onMessage?.(message)
    if (message.type === "error") {
      if (message.retryable) {
        this.options.onStatus?.("host_pending", message)
        const ws = this.ws
        this.ws = null
        ws?.close()
        this.closePeer()
        this.scheduleReconnect()
      } else {
        this.retryStopped = true
        this.options.onStatus?.("error", message)
      }
      return
    }
    if (message.type === "webrtc.host.ready") {
      this.markStable()
      this.options.onStatus?.("host_ready", message)
      await this.negotiate()
      return
    }
    if (message.type === "webrtc.host.pending") {
      this.options.onStatus?.("host_pending", message)
      return
    }
    const parsedSignal = BrowserWebRTCSignalSchema.safeParse(message)
    if (parsedSignal.success && parsedSignal.data.connectionId !== this.connectionId) return
    if (parsedSignal.success && parsedSignal.data.generation !== this.generation) return
    if (parsedSignal.success && parsedSignal.data.type === "webrtc.answer") {
      await this.pc?.setRemoteDescription({ type: "answer", sdp: parsedSignal.data.sdp })
      return
    }
    if (parsedSignal.success && parsedSignal.data.type === "webrtc.ice") {
      await this.pc?.addIceCandidate(parsedSignal.data.candidate)
      return
    }
    if (parsedSignal.success && parsedSignal.data.type === "webrtc.close") {
      this.closePeer()
      this.options.onStatus?.("signaling", parsedSignal.data)
      return
    }
    if (parsedSignal.success && parsedSignal.data.type === "webrtc.error") {
      this.retryStopped = true
      this.options.onStatus?.("error", parsedSignal.data)
    }
  }

  private sendSignal(message: BrowserWebRTCSignal): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(message))
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, Math.min(attempt - 1, 5)), 30_000)
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true)
}
