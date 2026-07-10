import { afterEach, describe, expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"

class Socket implements BrowserBrokerSocket {
  sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

afterEach(() => BrowserBroker.resetForTest())

describe("Browser Host broker authentication", () => {
  test("accepts only the registration secret and rejects events for unknown owner pages", () => {
    const forged = new Socket()
    expect(() =>
      BrowserBroker.attach(forged, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "forged",
        token: "0".repeat(64),
        capabilities: { native: true, webrtc: true },
      }),
    ).toThrow(/secret/i)
    expect(forged.closed?.code).toBe(1008)

    const host = new Socket()
    BrowserBroker.attach(host, {
      type: "host.register",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "host",
      token: BrowserBroker.secret(),
      capabilities: { native: true, webrtc: true },
    })
    expect(BrowserBroker.ready("native")).toBe(true)
    expect(host.sent).toContainEqual({
      type: "host.registered",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: "host",
    })

    const replacement = new Socket()
    expect(() =>
      BrowserBroker.attach(replacement, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "replacement",
        token: BrowserBroker.secret(),
        capabilities: { native: true, webrtc: true },
      }),
    ).toThrow(/already registered/i)
    expect(replacement.closed?.code).toBe(1013)
    expect(BrowserBroker.ready("native")).toBe(true)

    BrowserBroker.handle(host, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "another-owner",
      pageId: "unknown-page",
      event: { type: "page.error", pageId: "unknown-page", message: "forged event" },
    })
    expect(host.closed?.code).toBe(1008)
  })
})
