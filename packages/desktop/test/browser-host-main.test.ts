import { describe, expect, test } from "bun:test"
import { electronMockState, registerElectronMock } from "./electron-mock"
import { registerBrowserCollaboratorMocks } from "./browser-collaborators-mock"

registerElectronMock()
registerBrowserCollaboratorMocks()

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  url: string

  constructor(url: string | URL) {
    super()
    this.url = String(url)
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
}

async function importHostMain(query: string, websockets: FakeWebSocket[]) {
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url)
      websockets.push(this as unknown as FakeWebSocket)
    }
  } as unknown as typeof WebSocket
  try {
    await import(`../src/browser-host-main.js?${query}`)
    await Bun.sleep(0)
  } finally {
    globalThis.WebSocket = OriginalWebSocket
  }
}

describe("Browser Host main entry", () => {
  test("connects the real broker with the resolved desktop theme when configuration is present", async () => {
    process.env.SYNERGY_BROWSER_HOST_SERVER_URL = "http://127.0.0.1:8765"
    process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET = "a".repeat(64)
    const sockets: FakeWebSocket[] = []

    await importHostMain("with-config", sockets)

    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.url).toContain("/browser/host/broker")
    expect(sockets[0]!.url).toContain("protocolVersion=2")

    sockets[0]!.open()
    expect(sockets[0]!.sent).toHaveLength(1)
    const register = JSON.parse(sockets[0]!.sent[0]!) as {
      type: string
      token: string
      hostId: string
      capabilities: { native: boolean; webrtc: boolean }
    }
    expect(register).toMatchObject({
      type: "host.register",
      token: "a".repeat(64),
      hostId: expect.stringMatching(/^browser-host-/),
      capabilities: { native: false, webrtc: true },
    })
  })

  test("reports a startup failure when the server URL or secret is missing", async () => {
    const previousServerUrl = process.env.SYNERGY_BROWSER_HOST_SERVER_URL
    const previousToken = process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args.join(" "))
    try {
      delete process.env.SYNERGY_BROWSER_HOST_SERVER_URL
      delete process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET
      electronMockState.exitCode = 0

      await importHostMain("missing-config", [])

      expect(errors.some((entry) => entry.includes("requires server URL"))).toBe(true)
      expect(electronMockState.exitCode).toBe(1)
    } finally {
      process.env.SYNERGY_BROWSER_HOST_SERVER_URL = previousServerUrl
      process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET = previousToken
      console.error = original
    }
  })

  test("registers window-all-closed and before-quit handlers for process lifetime", async () => {
    await importHostMain("handlers", [])
    expect(electronMockState.appEmitter.listenerCount("window-all-closed")).toBeGreaterThan(0)
    expect(electronMockState.appEmitter.listenerCount("before-quit")).toBeGreaterThan(0)
  })
})
