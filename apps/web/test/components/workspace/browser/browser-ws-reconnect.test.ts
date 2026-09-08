import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserNativePresentationCapabilityResult,
  type BrowserNativePresentationTicketResult,
} from "@ericsanchezok/synergy-browser"
import type { BrowserNativeViewBridge } from "../../../../src/context/platform"
import { createBrowserStore } from "../../../../src/components/workspace/browser/browser-store"

// createBrowserWebSocket reads the platform bridge through usePlatform() at
// construction time, so the bridge must be a mutable module-level reference
// that each test can swap before mounting the handle.
let bridge: BrowserNativeViewBridge | null = null

mock.module("@/context/sdk", () => ({
  useSDK: () => ({
    url: "http://127.0.0.1:4096",
    client: { browser: {} },
    directory: undefined,
    scopeID: "home",
    scopeKey: "home",
  }),
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ browserNative: bridge }),
}))

// The events socket is a real WebSocket in production; swapping the global
// lets us capture the constructed URL without any network access.
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = MockWebSocket.CONNECTING
  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }
  addEventListener() {}
  close() {}
}

function bridgeStub(
  overrides: Partial<Pick<BrowserNativeViewBridge, "presentationCapability" | "createPresentationTicket">> = {},
): BrowserNativeViewBridge {
  return {
    async attachView() {},
    async detachView() {},
    async focusView() {},
    async resizeView() {},
    async retryPage() {},
    async presentationCapability() {
      return { protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: true, status: "ready" }
    },
    async createPresentationTicket() {
      return { ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION, ticket: "ticket" }
    },
    ...overrides,
  }
}

const OriginalWebSocket = globalThis.WebSocket

const { createBrowserWebSocket } = await import("../../../../src/components/workspace/browser/browser-ws")

function mountNativeWebSocket() {
  Object.defineProperty(globalThis, "WebSocket", {
    value: MockWebSocket,
    configurable: true,
    writable: true,
  })
  MockWebSocket.instances = []
}

function mountHandle() {
  const store = createBrowserStore()
  let disposeRoot: (() => void) | undefined
  const handle = createRoot((dispose) => {
    disposeRoot = dispose
    return createBrowserWebSocket(store, {
      sessionID: "ses_1",
      ownerKey: "owner-1",
      routeDirectory: "aG9tZQ",
      presentation: "native",
    })
  })
  return { store, handle, dispose: () => disposeRoot?.() }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    value: OriginalWebSocket,
    configurable: true,
    writable: true,
  })
  bridge = null
})

describe("createBrowserWebSocket native reconnect", () => {
  test("schedules an automatic reconnect after a ticket failure", async () => {
    mountNativeWebSocket()
    let capabilityCalls = 0
    bridge = bridgeStub({
      async presentationCapability(): Promise<BrowserNativePresentationCapabilityResult> {
        capabilityCalls++
        return {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          managedLocal: capabilityCalls > 1,
          status: "ready",
        }
      },
    })
    const { store, handle, dispose } = mountHandle()

    void handle.connect()
    await sleep(50)
    expect(store.session.connectionStatus).toBe("failed")

    // The scheduled reconnect (2s) re-runs the capability probe and, once the
    // Host is ready, builds the events socket with a fresh native ticket.
    await sleep(2_300)
    expect(capabilityCalls).toBeGreaterThanOrEqual(2)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]!.url).toContain("/aG9tZQ/browser/events")
    expect(MockWebSocket.instances[0]!.url).toContain("nativeTicket=ticket")

    dispose()
  })

  test("retryNative reconnects immediately when no socket is open", async () => {
    mountNativeWebSocket()
    let capabilityCalls = 0
    bridge = bridgeStub({
      async presentationCapability(): Promise<BrowserNativePresentationCapabilityResult> {
        capabilityCalls++
        return { protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: false, status: "failed" }
      },
    })
    const { store, handle, dispose } = mountHandle()

    void handle.connect()
    await sleep(50)
    expect(capabilityCalls).toBe(1)
    expect(store.session.connectionStatus).toBe("failed")

    // The coordinator retry alone cannot recover a session whose socket was
    // never opened; retryNative must reconnect immediately instead of waiting
    // for the scheduled 2s timer.
    handle.retryNative()
    await sleep(100)
    expect(capabilityCalls).toBe(2)

    dispose()
  })
})
