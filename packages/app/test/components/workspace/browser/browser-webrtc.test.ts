import { afterEach, describe, expect, test } from "bun:test"
import { BrowserWebRTCClient } from "../../../../src/components/workspace/browser/browser-webrtc"

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
      pageId: "page_1",
    })

    await client.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.emit("open", {})

    expect(ws.sent).toEqual([])

    ws.emit("message", {
      data: JSON.stringify({ type: "webrtc.host.pending", protocolVersion: 2, pageId: "page_1" }),
    })
    expect(ws.sent).toEqual([])

    ws.emit("message", {
      data: JSON.stringify({ type: "webrtc.host.ready", protocolVersion: 2, pageId: "page_1" }),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: "webrtc.offer",
        protocolVersion: 2,
        pageId: "page_1",
        generation: 1,
        sdp: "fake-offer",
      }),
    )
    client.close()
  })

  test("reconnects signaling after a transient peer failure", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    const client = new BrowserWebRTCClient({
      signalingUrl: "ws://localhost/browser/webrtc/connect",
      pageId: "page_1",
    })

    await client.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.emit("open", {})
    ws.emit("message", {
      data: JSON.stringify({ type: "webrtc.host.ready", protocolVersion: 2, pageId: "page_1" }),
    })
    await Promise.resolve()
    await Promise.resolve()
    const firstOffer = ws.sent.find((message) => (message as { type?: string }).type === "webrtc.offer") as {
      connectionId: string
      generation: number
    }
    ws.emit("message", {
      data: JSON.stringify({
        type: "webrtc.answer",
        protocolVersion: 2,
        pageId: "page_1",
        connectionId: firstOffer.connectionId,
        generation: firstOffer.generation,
        sdp: "fake-answer",
      }),
    })
    await Promise.resolve()

    const firstPeer = FakeRTCPeerConnection.instances[0]!
    firstPeer.connectionState = "failed"
    firstPeer.onconnectionstatechange?.()
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const retrySocket = FakeWebSocket.instances[1]!
    retrySocket.emit("open", {})
    retrySocket.emit("message", {
      data: JSON.stringify({ type: "webrtc.host.ready", protocolVersion: 2, pageId: "page_1" }),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(firstPeer.closed).toBe(true)
    expect(FakeRTCPeerConnection.instances).toHaveLength(2)
    expect(retrySocket.sent.filter((message) => (message as { type?: string }).type === "webrtc.offer")).toHaveLength(1)
    client.close()
  })

  test("surfaces versioned host signaling errors and socket closure as statuses", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    const statuses: string[] = []
    const client = new BrowserWebRTCClient({
      signalingUrl: "ws://localhost/browser/webrtc/connect",
      pageId: "page_1",
      onStatus: (status) => statuses.push(status),
    })

    await client.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.emit("open", {})
    ws.emit("message", {
      data: JSON.stringify({ type: "webrtc.host.ready", protocolVersion: 2, pageId: "page_1" }),
    })
    await Promise.resolve()
    await Promise.resolve()
    const offer = ws.sent.find((message) => (message as { type?: string }).type === "webrtc.offer") as {
      connectionId: string
      generation: number
    }
    ws.emit("message", {
      data: JSON.stringify({
        type: "webrtc.error",
        protocolVersion: 2,
        pageId: "page_1",
        connectionId: offer.connectionId,
        generation: offer.generation,
        message: "capture failed",
      }),
    })
    ws.emit("close", {})

    expect(statuses).toContain("error")
    expect(statuses).toContain("closed")
    client.close()
  })

  test("retries only retryable ticket failures and ignores stale ticket resolution after close", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    let permanentCalls = 0
    let retryableCalls = 0
    let resolveStale: ((value: { url: string }) => void) | undefined

    const permanent = new BrowserWebRTCClient({
      signalingUrl: async () => {
        permanentCalls++
        throw Object.assign(new Error("denied"), { retryable: false })
      },
      pageId: "permanent",
    })
    const retryable = new BrowserWebRTCClient({
      signalingUrl: async () => {
        retryableCalls++
        throw Object.assign(new Error("pending"), { retryable: true })
      },
      pageId: "retryable",
    })
    const stale = new BrowserWebRTCClient({
      signalingUrl: () => new Promise((resolve) => (resolveStale = resolve)),
      pageId: "stale",
    })

    await Promise.all([permanent.connect(), retryable.connect(), stale.connect()])
    stale.close()
    resolveStale?.({ url: "ws://localhost/stale" })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(permanentCalls).toBe(1)
    expect(retryableCalls).toBeGreaterThan(1)
    expect(FakeWebSocket.instances).toHaveLength(0)
    permanent.close()
    retryable.close()
  })
})
