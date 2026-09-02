import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, type BrowserHostMessage } from "@ericsanchezok/synergy-browser"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"
import { BrowserEvent } from "../../src/browser/event"
import { BrowserHostPage } from "../../src/browser/host-page"
import type { BrowserOwner } from "../../src/browser/owner"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope-host-page",
  sessionID: "session-host-page",
  directory: "/tmp/synergy-browser-host-page",
}

class HostSocket implements BrowserBrokerSocket {
  sent: BrowserHostMessage[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string): void {
    const message = JSON.parse(data) as BrowserHostMessage
    this.sent.push(message)
    if (message.type === "page.create") {
      queueMicrotask(() =>
        BrowserBroker.handle(this, {
          type: "page.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: message.requestId,
          result: { type: "page", page: message.page },
        }),
      )
    }
    if (message.type === "page.command") {
      queueMicrotask(() =>
        BrowserBroker.handle(this, {
          type: "page.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: message.requestId,
          result:
            message.command.type === "resume"
              ? { type: "page", page: { ...page, id: message.pageId } }
              : { type: "void" },
        }),
      )
    }
    if (message.type === "page.close") {
      queueMicrotask(() =>
        BrowserBroker.handle(this, {
          type: "page.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: message.requestId,
          result: { type: "void" },
        }),
      )
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

const page = {
  id: "page-host-gate",
  url: "https://example.com/",
  title: "Example",
  isLoading: false,
  lastActiveAt: null,
}

let host: HostSocket
let browserPage: BrowserHostPage

beforeEach(async () => {
  BrowserBroker.resetForTest()
  BrowserEvent.resetForTest()
  host = new HostSocket()
  BrowserBroker.attach(host, {
    type: "host.register",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    hostId: "host-page-test",
    token: BrowserBroker.secret(),
    capabilities: { native: true, webrtc: false },
  })
  BrowserBroker.prepare(owner, "home", "native")
  browserPage = await BrowserHostPage.create({
    owner,
    id: page.id,
    url: page.url,
    presentation: "native",
    routeDirectory: "home",
    events: {},
  })
})

afterEach(async () => {
  await browserPage?.close().catch(() => undefined)
  await Promise.resolve()
  BrowserBroker.resetForTest()
  BrowserEvent.resetForTest()
})

describe("BrowserHostPage recovery gate", () => {
  test("fails side effects during restart while allowing resume through to the Host", async () => {
    BrowserBroker.handle(host, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "scope:scope-host-page:session:session-host-page",
      pageId: page.id,
      event: { type: "host.status", pageId: page.id, status: "restarting" },
    })

    await expect(browserPage.execute({ type: "reload", source: "agent" })).rejects.toMatchObject({
      code: "browser_native_restarting",
      retryable: true,
      pageId: page.id,
      message: expect.stringContaining("browser_navigation with action resume"),
    })

    const commandsBeforeResume = host.sent.filter((message) => message.type === "page.command").length
    await expect(browserPage.execute({ type: "resume" })).resolves.toMatchObject({
      type: "page",
      page: { id: page.id },
    })
    expect(host.sent.filter((message) => message.type === "page.command")).toHaveLength(commandsBeforeResume + 1)
  })

  test("allows observations and close in failed state but blocks mutating commands", async () => {
    BrowserBroker.handle(host, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "scope:scope-host-page:session:session-host-page",
      pageId: page.id,
      event: { type: "host.status", pageId: page.id, status: "failed" },
    })

    await expect(browserPage.execute({ type: "reload", source: "agent" })).rejects.toMatchObject({
      code: "browser_native_recovery_failed",
      retryable: true,
      message: expect.stringContaining("native Browser Retry control"),
    })
    const commandsBeforeSnapshot = host.sent.filter((message) => message.type === "page.command").length
    await expect(browserPage.execute({ type: "snapshot" })).resolves.toEqual({ type: "void" })
    expect(host.sent.filter((message) => message.type === "page.command")).toHaveLength(commandsBeforeSnapshot + 1)
    const commandsBeforeClose = host.sent.filter((message) => message.type === "page.command").length
    await expect(browserPage.execute({ type: "close" })).resolves.toEqual({ type: "void" })
    expect(host.sent.filter((message) => message.type === "page.command")).toHaveLength(commandsBeforeClose + 1)
  })

  test("clears the recovery gate when the Host reports ready after a restart", async () => {
    BrowserBroker.handle(host, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "scope:scope-host-page:session:session-host-page",
      pageId: page.id,
      event: { type: "host.status", pageId: page.id, status: "restarting" },
    })

    await expect(browserPage.execute({ type: "reload", source: "agent" })).rejects.toMatchObject({
      code: "browser_native_restarting",
      retryable: true,
    })

    BrowserBroker.handle(host, {
      type: "page.event",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: "scope:scope-host-page:session:session-host-page",
      pageId: page.id,
      event: { type: "host.status", pageId: page.id, status: "ready" },
    })

    const commandsBeforeReload = host.sent.filter((message) => message.type === "page.command").length
    await expect(browserPage.execute({ type: "reload", source: "agent" })).resolves.toEqual({ type: "void" })
    expect(host.sent.filter((message) => message.type === "page.command")).toHaveLength(commandsBeforeReload + 1)
  })
})
