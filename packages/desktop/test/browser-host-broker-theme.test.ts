import { expect, mock, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, type BrowserHostMessage } from "@ericsanchezok/synergy-browser"
import { defaultDesktopSkinState, desktopThemeSnapshot, type DesktopThemeSnapshot } from "../src/theme"

const started = deferred<void>()
const releaseStart = deferred<void>()
const appliedThemes: DesktopThemeSnapshot[] = []

class MockWebRTCHost {
  constructor(private options: { theme: DesktopThemeSnapshot }) {}

  async start() {
    started.resolve()
    await releaseStart.promise
  }

  setTheme(theme: DesktopThemeSnapshot) {
    this.options.theme = theme
    appliedThemes.push(theme)
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

class TestBroker extends BrowserHostBrokerClient {
  async createPage(message: Extract<BrowserHostMessage, { type: "page.create" }>) {
    await (this as unknown as { dispatch(message: BrowserHostMessage, epoch: number): Promise<void> }).dispatch(
      message,
      0,
    )
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
