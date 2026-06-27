import type { BrowserWebRTCSignalMessage } from "@ericsanchezok/synergy-util/browser-protocol"

type BrowserWebRTCSignalingUrlOptions = {
  serverUrl: string
  sessionID: string
  tabId?: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  client?: "web" | "desktop"
  sameHost?: boolean
  traceId?: string
}

export function createBrowserWebRTCSignalingUrl(options: BrowserWebRTCSignalingUrlOptions) {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) return null

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: "webrtc",
    client: options.client ?? "web",
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.sameHost) params.set("sameHost", "1")
  if (options.tabId) params.set("tabId", options.tabId)
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
  signalingUrl: string
  tabId: string
  rtcConfiguration?: RTCConfiguration
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
  private negotiating: Promise<void> | null = null

  constructor(private options: BrowserWebRTCClientOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Browser WebRTC client is closed")
    this.options.onStatus?.("signaling")

    this.createPeer()
    this.connectSignaling()
  }

  sendInput(payload: unknown): boolean {
    if (this.input?.readyState !== "open") return false
    this.input.send(JSON.stringify(payload))
    return true
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.sendSignal({ type: "webrtc.close", tabId: this.options.tabId })
    this.closePeer()
    this.ws?.close()
    this.ws = null
  }

  private createPeer(): RTCPeerConnection {
    if (this.pc) return this.pc
    const pc = new RTCPeerConnection(this.options.rtcConfiguration)
    this.pc = pc
    pc.addTransceiver("video", { direction: "recvonly" })
    pc.addTransceiver("audio", { direction: "recvonly" })
    this.input = pc.createDataChannel("browser-input", { ordered: true })

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.options.onStream?.(stream)
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.sendSignal({
        type: "webrtc.ice",
        tabId: this.options.tabId,
        candidate: event.candidate.toJSON(),
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
    const ws = new WebSocket(this.options.signalingUrl)
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
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connectSignaling(), 1000)
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
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.sendSignal({ type: "webrtc.offer", tabId: this.options.tabId, sdp: offer.sdp ?? "" })
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

    this.options.onMessage?.(msg)
    if (msg.type === "webrtc.host.ready") {
      this.options.onStatus?.("host_ready", msg)
      await this.negotiate()
      return
    }
    if (msg.type === "webrtc.answer" && typeof msg.sdp === "string") {
      await this.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp })
      return
    }
    if (msg.type === "webrtc.ice" && msg.candidate) {
      await this.pc?.addIceCandidate(msg.candidate)
      return
    }
    if (msg.type === "webrtc.host.pending") {
      this.options.onStatus?.("host_pending", msg)
    }
  }

  private sendSignal(message: BrowserWebRTCSignalMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(message))
  }
}
