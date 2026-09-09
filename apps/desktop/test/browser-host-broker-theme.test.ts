import { expect, mock, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, type BrowserHostMessage } from "@ericsanchezok/synergy-browser"
import { defaultDesktopSkinState, desktopThemeSnapshot, type DesktopThemeSnapshot } from "../src/theme"

const started = deferred<void>()
const releaseStart = deferred<void>()
const appliedThemes: DesktopThemeSnapshot[] = []
const createdHosts: MockWebRTCHost[] = []

class MockWebRTCHost {
  renewedTickets: string[] = []

  constructor(private options: { theme: DesktopThemeSnapshot }) {
    createdHosts.push(this)
  }

  async start() {
    started.resolve()
    await releaseStart.promise
  }

  setTheme(theme: DesktopThemeSnapshot) {
    this.options.theme = theme
    appliedThemes.push(theme)
  }

  updateSignalingTicket(ticket: string) {
    this.renewedTickets.push(ticket)
  }

  state() {
    return { id: "page-test", url: "about:blank", title: "", isLoading: false, lastActiveAt: null }
  }

  async destroy() {}
  isAlive() {
    return true
  }
}

mock.module("../src/browser-webrtc-host.js", () => ({ BrowserWebRTCHost: MockWebRTCHost }))

const { BrowserHostBrokerClient } = await import("../src/browser-host-broker.js")

test("reports connecting, registered, and reconnecting broker states", async () => {
  const OriginalWebSocket = globalThis.WebSocket
  const sockets: FakeWebSocket[] = []
  class FakeWebSocket extends EventTarget {
    static OPEN = 1
    readyState = 0
    sent: string[] = []

    constructor(_url: string | URL) {
      super()
      sockets.push(this)
    }

    send(data: string) {
      this.sent.push(data)
    }

    close() {
      this.dispatchEvent(new Event("close"))
    }

    open() {
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event("open"))
    }

    message(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }))
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  const states: string[] = []
  const broker = new BrowserHostBrokerClient({
    serverUrl: "http://127.0.0.1:3000",
    token: "a".repeat(64),
    theme: desktopThemeSnapshot(defaultDesktopSkinState(), false),
    onStatus: (status) => states.push(status),
  })
  try {
    broker.connect()
    sockets[0].open()
    sockets[0].message({ type: "host.registered", protocolVersion: 2, hostId: "host-test" })
    await Promise.resolve()
    sockets[0].close()
    await Promise.resolve()

    expect(states).toEqual(["connecting", "ready", "restarting"])
  } finally {
    await broker.close()
    globalThis.WebSocket = OriginalWebSocket
  }
})

class TestBroker extends BrowserHostBrokerClient {
  async createPage(message: Extract<BrowserHostMessage, { type: "page.create" }>) {
    await (this as unknown as { dispatch(message: BrowserHostMessage, epoch: number): Promise<void> }).dispatch(
      message,
      0,
    )
  }

  async receive(input: unknown) {
    await (this as unknown as { handle(data: unknown, epoch: number): Promise<void> }).handle(JSON.stringify(input), 0)
  }
}

test("a page finishing asynchronous creation receives the latest broker theme", async () => {
  const initial = desktopThemeSnapshot(defaultDesktopSkinState(), false)
  const latest = desktopThemeSnapshot(
    {
      ...defaultDesktopSkinState(),
      themeId: "latest",
      light: { ...defaultDesktopSkinState().light, background: "#123456" },
    },
    false,
  )
  const broker = new TestBroker({ serverUrl: "http://127.0.0.1:3000", token: "a".repeat(64), theme: initial })
  ;(broker as unknown as { connectionEpoch: number }).connectionEpoch = 0
  ;(broker as unknown as { socket: { readyState: number; send(): void } }).socket = {
    readyState: WebSocket.OPEN,
    send() {},
  }

  const creation = broker.createPage({
    type: "page.create",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestId: "request-test",
    ownerKey: "scope-test:session:session-test",
    owner: { mode: "session", scopeID: "scope-test", sessionID: "session-test", directory: "/tmp" },
    routeDirectory: "home",
    presentation: "webrtc",
    page: { id: "page-test", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
    networkProxy: { server: "http://127.0.0.1:3000", username: "user", password: "password" },
    downloadDir: "/tmp",
    signalingTicket: "ticket",
  })

  await started.promise
  broker.setTheme(latest)
  releaseStart.resolve()
  await creation

  expect(appliedThemes.at(-1)).toEqual(latest)
})

test("forwards renewed signaling tickets only to the matching WebRTC page", async () => {
  const theme = desktopThemeSnapshot(defaultDesktopSkinState(), false)
  const broker = new TestBroker({ serverUrl: "http://127.0.0.1:3000", token: "a".repeat(64), theme })
  ;(broker as unknown as { connectionEpoch: number }).connectionEpoch = 0
  ;(broker as unknown as { socket: { readyState: number; send(): void; close(): void } }).socket = {
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  }

  const before = createdHosts.length
  const creation = broker.createPage({
    type: "page.create",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    requestId: "request-signaling",
    ownerKey: "scope-test:session:session-signaling",
    owner: { mode: "session", scopeID: "scope-test", sessionID: "session-signaling", directory: "/tmp" },
    routeDirectory: "home",
    presentation: "webrtc",
    page: { id: "page-signaling", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
    networkProxy: { server: "http://127.0.0.1:3000", username: "user", password: "password" },
    downloadDir: "/tmp",
    signalingTicket: "initial-ticket",
  })
  releaseStart.resolve()
  await creation

  const host = createdHosts[before]
  expect(host).toBeDefined()
  await broker.receive({
    type: "page.signaling.ticket",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    ownerKey: "scope-test:session:session-signaling",
    pageId: "page-signaling",
    signalingTicket: "renewed-ticket",
  })
  await broker.receive({
    type: "page.signaling.ticket",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    ownerKey: "scope-test:session:session-signaling",
    pageId: "other-page",
    signalingTicket: "wrong-page-ticket",
  })

  expect(host.renewedTickets).toEqual(["renewed-ticket"])
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
