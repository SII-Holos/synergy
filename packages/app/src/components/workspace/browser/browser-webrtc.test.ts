import { afterEach, describe, expect, test } from "bun:test"
import { BrowserWebRTCClient } from "./browser-webrtc"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1

  readyState = FakeWebSocket.OPEN
  sent: unknown[] = []
  private listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.emit("close", {})
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = []

  connectionState = "new"
  signalingState = "stable"
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  closed = false

  constructor() {
    FakeRTCPeerConnection.instances.push(this)
  }

  addTransceiver() {}

  createDataChannel() {
    return {
      readyState: "open",
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data)
      },
      close() {
        this.readyState = "closed"
      },
    }
  }

  async createOffer() {
    return { type: "offer", sdp: "fake-offer" }
  }

  async setLocalDescription() {
    this.signalingState = "have-local-offer"
  }

  async setRemoteDescription() {
    this.signalingState = "stable"
  }

  async addIceCandidate() {}

  close() {
    this.closed = true
    this.connectionState = "closed"
    this.signalingState = "closed"
  }
}

const originalWebSocket = globalThis.WebSocket
const originalRTCPeerConnection = globalThis.RTCPeerConnection

describe("BrowserWebRTCClient", () => {
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
    FakeWebSocket.instances = []
    FakeRTCPeerConnection.instances = []
  })

  test("waits for Browser Host readiness before sending an offer", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    const client = new BrowserWebRTCClient({
      signalingUrl: "ws://localhost/browser/webrtc/connect",
      tabId: "tab_1",
    })

    await client.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.emit("open", {})

    expect(ws.sent).toEqual([])

    ws.emit("message", { data: JSON.stringify({ type: "webrtc.host.pending", tabId: "tab_1" }) })
    expect(ws.sent).toEqual([])

    ws.emit("message", { data: JSON.stringify({ type: "webrtc.host.ready", tabId: "tab_1" }) })
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent).toContainEqual({ type: "webrtc.offer", tabId: "tab_1", sdp: "fake-offer" })
    client.close()
  })

  test("recreates a failed peer when the Browser Host becomes ready again", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    const client = new BrowserWebRTCClient({
      signalingUrl: "ws://localhost/browser/webrtc/connect",
      tabId: "tab_1",
    })

    await client.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.emit("open", {})
    ws.emit("message", { data: JSON.stringify({ type: "webrtc.host.ready", tabId: "tab_1" }) })
    await Promise.resolve()
    await Promise.resolve()
    ws.emit("message", { data: JSON.stringify({ type: "webrtc.answer", tabId: "tab_1", sdp: "fake-answer" }) })
    await Promise.resolve()

    const firstPeer = FakeRTCPeerConnection.instances[0]!
    firstPeer.connectionState = "failed"
    firstPeer.onconnectionstatechange?.()

    ws.emit("message", { data: JSON.stringify({ type: "webrtc.host.ready", tabId: "tab_1" }) })
    await Promise.resolve()
    await Promise.resolve()

    expect(firstPeer.closed).toBe(true)
    expect(FakeRTCPeerConnection.instances).toHaveLength(2)
    expect(ws.sent.filter((message) => (message as { type?: string }).type === "webrtc.offer")).toHaveLength(2)
    client.close()
  })
})
