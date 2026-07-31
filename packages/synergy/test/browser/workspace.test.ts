import { afterEach, describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
  type BrowserPresentation,
} from "@ericsanchezok/synergy-browser"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"
import { BrowserNetworkGateway } from "../../src/browser/network-gateway"
import type { BrowserOwner } from "../../src/browser/owner"
import { BrowserTicket } from "../../src/browser/ticket"
import { BrowserWebRTCSignaling } from "../../src/browser/webrtc-signaling"
import { BrowserWorkspace } from "../../src/browser/workspace"

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

afterEach(async () => {
  BrowserWebRTCSignaling.resetForTest()
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
