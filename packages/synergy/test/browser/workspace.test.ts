import { afterEach, describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
  type BrowserPresentation,
} from "@ericsanchezok/synergy-browser"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"
import { BrowserHostBrokerProcess } from "../../src/browser/host-broker-process"
import { BrowserNetworkGateway } from "../../src/browser/network-gateway"
import { BrowserCommandService } from "../../src/browser/command-service"
import type { BrowserPageBackend } from "../../src/browser/page"
import type { BrowserSession } from "../../src/browser/types"
import type { BrowserOwner } from "../../src/browser/owner"
import { BrowserTicket } from "../../src/browser/ticket"
import { BrowserWebRTCSignaling } from "../../src/browser/webrtc-signaling"
import { BrowserWorkspace } from "../../src/browser/workspace"
import { BunProc } from "../../src/util/bun"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope-workspace",
  sessionID: "session-workspace",
  directory: "/tmp",
}

const session = {
  status: "active" as const,
  page: { id: "page-1", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
}

class BrokerSocket implements BrowserBrokerSocket {
  sent: BrowserHostMessage[] = []

  send(data: string): void {
    const message = BrowserHostMessageSchema.parse(JSON.parse(data))
    this.sent.push(message)
    if (message.type !== "page.create") return
    queueMicrotask(() => {
      BrowserBroker.handle(this, {
        type: "page.result",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: message.requestId,
        result: { type: "page", page: message.page },
      })
    })
  }

  close(): void {}
}
function fakeSession(): BrowserSession {
  const page: BrowserPageBackend = {
    id: "page-1",
    backend: "host",
    url: "about:blank",
    title: "",
    loading: false,
    lastActiveAt: null,
    async execute(command) {
      if (command.type === "navigate") {
        page.url = command.url
        return {
          type: "navigation",
          page: { id: page.id, url: page.url, title: "", isLoading: false, lastActiveAt: null },
        }
      }
      return { type: "void" }
    },
    async close() {},
    isAlive() {
      return true
    },
  }
  return {
    owner,
    page: null,
    status: "empty",
    descriptor: null,
    annotations: [],
    checkpoint: null,
    error: null,
    async ensurePage() {
      return page
    },
    async resumePage() {
      return page
    },
    async closePage() {},
    getPage(id) {
      return id === page.id ? page : undefined
    },
    async addAnnotation() {
      throw new Error("not implemented")
    },
    async removeAnnotation() {
      return false
    },
    async clearAnnotations() {},
    formatAnnotationsForContext() {
      return ""
    },
    async notifyPageNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async suspend() {},
    async dispose() {},
  }
}

function presentation(kind: "native" | "webrtc"): BrowserPresentation {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind,
    capabilities: { native: true, webrtc: true },
    reason: "requested",
  }
}

async function createBrokerPage() {
  const broker = new BrokerSocket()
  BrowserBroker.attach(broker, {
    type: "host.register",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    hostId: "host-workspace",
    token: BrowserBroker.secret(),
    capabilities: { native: true, webrtc: true },
  })
  await BrowserBroker.createPage({
    owner,
    routeDirectory: "home",
    presentation: "webrtc",
    pageId: "page-1",
  })
}

const originalAutostart = process.env.SYNERGY_BROWSER_HOST_AUTOSTART
const originalCommand = process.env.SYNERGY_BROWSER_HOST_COMMAND

afterEach(async () => {
  if (originalAutostart === undefined) delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART
  else process.env.SYNERGY_BROWSER_HOST_AUTOSTART = originalAutostart
  if (originalCommand === undefined) delete process.env.SYNERGY_BROWSER_HOST_COMMAND
  else process.env.SYNERGY_BROWSER_HOST_COMMAND = originalCommand
  BrowserWebRTCSignaling.resetForTest()
  BrowserHostBrokerProcess.resetForTest()
  BrowserBroker.resetForTest()
  BrowserTicket.resetForTest()
  await BrowserNetworkGateway.stop()
})

describe("Browser workspace Host readiness", () => {
  test("reports a broker-owned WebRTC page detached until Host signaling attaches", async () => {
    await createBrokerPage()

    expect(BrowserWorkspace.sessionStatePayload(owner, session, presentation("webrtc")).hostStatus).toBe("detached")

    const host = { send() {}, close() {} }
    BrowserWebRTCSignaling.attachHost(owner, "page-1", host, { hostReady: true })
    expect(BrowserWorkspace.sessionStatePayload(owner, session, presentation("webrtc")).hostStatus).toBe("ready")

    BrowserWebRTCSignaling.detachHost(owner, "page-1", host)
    expect(BrowserWorkspace.sessionStatePayload(owner, session, presentation("webrtc")).hostStatus).toBe("detached")
  })

  test("keeps a broker-owned native page ready without WebRTC signaling", async () => {
    await createBrokerPage()

    expect(BrowserWorkspace.sessionStatePayload(owner, session, presentation("native")).hostStatus).toBe("ready")
  })
})

describe("Browser workspace Host registration wait", () => {
  test("fails immediately when the WebRTC Host is unavailable", async () => {
    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "false"
    await expect(
      BrowserWorkspace.executeControl(
        {
          directory: "/tmp",
          owner,
          presentation: presentation("webrtc"),
          requestedPresentation: "webrtc",
          nativePresentation: false,
        },
        { command: { type: "navigate", source: "user", url: "https://example.com" }, commandId: "cmd-unavailable" },
        "http://localhost:4096",
      ),
    ).rejects.toMatchObject({ code: "browser_host_unavailable", message: expect.stringContaining("unavailable") })
  })

  test("waits beyond the legacy 10s window while the WebRTC Host starts", async () => {
    process.env.SYNERGY_BROWSER_HOST_COMMAND = JSON.stringify([BunProc.which(), "-e", "setInterval(() => {}, 1000)"])
    const restoreRuntime = BrowserCommandService.useRuntimeForTest({
      async getOrCreateSession() {
        return fakeSession()
      },
    })
    try {
      const control = BrowserWorkspace.executeControl(
        {
          directory: "/tmp",
          owner,
          presentation: presentation("webrtc"),
          requestedPresentation: "webrtc",
          nativePresentation: false,
        },
        { command: { type: "navigate", source: "user", url: "https://example.com" }, commandId: "cmd-starting" },
        "http://localhost:4096",
      )
      await new Promise((resolve) => setTimeout(resolve, 12_000))
      expect(BrowserHostBrokerProcess.status()).toBe("starting")
      const broker = new BrokerSocket()
      BrowserBroker.attach(broker, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host-workspace",
        token: BrowserBroker.secret(),
        capabilities: { native: false, webrtc: true },
      })
      const result = await control
      expect(result.status).toBe(200)
    } finally {
      restoreRuntime()
    }
  }, 30_000)
})
