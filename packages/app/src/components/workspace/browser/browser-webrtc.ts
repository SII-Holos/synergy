import {
  BROWSER_PROTOCOL_VERSION,
  BrowserRemoteInputSchema,
  BrowserWebRTCMessageSchema,
  BrowserWebRTCSignalSchema,
  type BrowserWebRTCSignal,
} from "@ericsanchezok/synergy-browser"

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private negotiating: Promise<void> | null = null
  private readonly connectionId = crypto.randomUUID()
  private generation = 0
  private iceSequence = 0
  private rtcConfiguration: RTCConfiguration | undefined

  constructor(private options: BrowserWebRTCClientOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Browser WebRTC client is closed")
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.sendSignal({
      type: "webrtc.close",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      generation: this.generation,
      pageId: this.options.pageId,
    })
    this.closePeer()
    this.ws?.close()
    this.ws = null
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
      if (pc.connectionState === "connected") this.options.onStatus?.("stream_ready")
      if (pc.connectionState === "failed") this.options.onStatus?.("error", { connectionState: pc.connectionState })
      if (pc.connectionState === "closed") this.options.onStatus?.("closed")
    }
    return pc
  }

  private connectSignaling(): void {
    if (this.closed) return
    this.options.onStatus?.("signaling")
    if (typeof this.options.signalingUrl === "string") {
      this.openSignaling(this.options.signalingUrl)
      return
    }
    void this.options
      .signalingUrl()
      .then((resolved) => {
        if (this.closed) return
        this.reconnectAttempt = 0
        this.rtcConfiguration = resolved.rtcConfiguration
        this.openSignaling(resolved.url)
      })
      .catch((error) => {
        if (this.closed) return
        const retryable = (error as Record<string, unknown>).retryable === true
        this.reconnectAttempt++
        const delay = retryable ? backoffDelay(this.reconnectAttempt) : backoffDelay(this.reconnectAttempt)
        this.options.onStatus?.(retryable ? "host_pending" : "error", error)
        this.reconnectTimer = setTimeout(() => this.connectSignaling(), delay)
      })
  }

  private openSignaling(url: string): void {
    if (this.closed) return
    this.createPeer()
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener("open", () => {
      this.createPeer()
    })

    ws.addEventListener("message", (event) => {
      void this.handleSignal(event.data)
    })

    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null
      this.options.onStatus?.("closed")
      if (!this.closed) {
        this.reconnectAttempt++
        this.reconnectTimer = setTimeout(() => this.connectSignaling(), backoffDelay(this.reconnectAttempt))
      }
    })

    ws.addEventListener("error", (event) => {
      this.options.onStatus?.("error", event)
    })
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
      this.options.onStatus?.("error", { message: "Invalid WebRTC signaling payload" })
      return
    }

    const parsedMessage = BrowserWebRTCMessageSchema.safeParse(msg)
    if (!parsedMessage.success) {
      this.options.onStatus?.("error", { message: "Invalid Browser WebRTC protocol message." })
      return
    }
    const message = parsedMessage.data
    this.options.onMessage?.(message)
    if (message.type === "error") {
      this.options.onStatus?.("error", message)
      return
    }
    if (message.type === "webrtc.host.ready") {
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
