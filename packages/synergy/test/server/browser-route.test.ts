import { afterEach, describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser"
import { BrowserNativeLease } from "@ericsanchezok/synergy-browser/native-lease"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/browser/broker"
import { BrowserCommandService } from "../../src/browser/command-service"
import { BrowserNetworkGateway } from "../../src/browser/network-gateway"
import { BrowserNativePresentation } from "../../src/browser/native-presentation"
import { BrowserOwner } from "../../src/browser/owner"
import { BrowserTicket } from "../../src/browser/ticket"
import type { BrowserSession } from "../../src/browser/types"
import { BrowserWebRTCSignaling } from "../../src/browser/webrtc-signaling"
import {
  browserHostOriginAllowed,
  browserSignalingEventSocket,
  browserSignalingPageAvailable,
  browserViewerOriginAllowed,
  configureBrowserViewerOrigins,
  createBrowserSignalingSocket,
} from "../../src/server/browser-route"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

let restoreRuntime: (() => void) | undefined
afterEach(async () => {
  restoreRuntime?.()
  restoreRuntime = undefined
  BrowserCommandService.clear()
  BrowserWebRTCSignaling.resetForTest()
  BrowserBroker.resetForTest()
  BrowserTicket.resetForTest()
  BrowserNativePresentation.resetForTest()
  configureBrowserViewerOrigins([])
  await BrowserNetworkGateway.stop()
})

function suspended(owner: BrowserOwner.Info): BrowserSession {
  return {
    owner,
    page: null,
    status: "suspended",
    descriptor: { id: "page-1", url: "https://example.com/", title: "Example", lastActiveAt: 1 },
    annotations: [],
    checkpoint: null,
    error: null,
    async ensurePage() {
      throw new Error("A read-only route must not create a page.")
    },
    async resumePage() {
      throw new Error("A read-only route must not resume a page.")
    },
    async closePage() {},
    async suspend() {},
    getPage() {
      return undefined
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
    async dispose() {},
  }
}

function active(owner: BrowserOwner.Info): BrowserSession {
  const page = {
    id: "page-1",
    backend: "host" as const,
    url: "https://example.com/",
    title: "Example",
    loading: false,
    lastActiveAt: 1,
    isAlive: () => true,
    async execute() {
      return { type: "void" as const }
    },
    async close() {},
  }
  return {
    ...suspended(owner),
    page,
    status: "active",
    getPage(pageID: string) {
      return pageID === page.id ? page : undefined
    },
  }
}

class BrokerSocket implements BrowserBrokerSocket {
  sent: BrowserHostMessage[] = []

  send(data: string): void {
    const message = BrowserHostMessageSchema.parse(JSON.parse(data))
    this.sent.push(message)
    if (message.type !== "page.create" && message.type !== "page.close") return
    queueMicrotask(() => {
      BrowserBroker.handle(this, {
        type: "page.result",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        requestId: message.requestId,
        result: message.type === "page.create" ? { type: "page", page: message.page } : { type: "void" },
      })
    })
  }

  close(): void {}
}

class SignalingSocket {
  sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

function signalingContext(ticket: string) {
  const queries: Record<string, string> = {
    mode: "session",
    sessionID: "session-route",
    presentation: "webrtc",
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
    pageId: "page-1",
    ticket,
  }
  return {
    req: {
      url: `http://127.0.0.1:4096/home/browser/webrtc/host?${new URLSearchParams(queries)}`,
      param(name: string) {
        return name === "directory" ? "home" : ""
      },
      query(name: string) {
        return queries[name]
      },
      header(name: string) {
        return name.toLowerCase() === "origin" ? "file://" : undefined
      },
    },
  }
}

async function withRoute(
  fn: (app: ReturnType<typeof Server.App>) => Promise<void>,
  sessionFactory: (owner: BrowserOwner.Info) => BrowserSession = suspended,
) {
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID: ScopeContext.current.scope.id,
        sessionID: "session-route",
        directory: ScopeContext.current.directory,
      }
      restoreRuntime = BrowserCommandService.useRuntimeForTest({
        async getOrCreateSession() {
          return sessionFactory(owner)
        },
      })
      await fn(Server.App())
    },
  })
}

describe("BrowserRoute protocol v2", () => {
  test("keeps an explicit native request strict when its ticket is missing", async () => {
    await withRoute(async (app) => {
      const response = await app.request(
        "/home/browser/session?mode=session&sessionID=session-route&presentation=native",
      )

      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        type: "error",
        code: "browser_native_ticket_required",
        retryable: true,
      })
    })
  })

  test("returns structured native ticket rejection without selecting WebRTC", async () => {
    await withRoute(async (app) => {
      const ticket = BrowserNativeLease.issue(BrowserBroker.secret(), {
        ownerKey: "scope:wrong:session:owner",
        serverOrigin: "http://localhost",
      })
      const response = await app.request(
        `/home/browser/session?mode=session&sessionID=session-route&presentation=native&nativeTicket=${encodeURIComponent(ticket)}`,
      )

      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        type: "error",
        code: "browser_native_ticket_owner_mismatch",
        retryable: true,
      })
    })
  })

  test("rejects expired and wrong-origin native tickets with stable retryable codes", async () => {
    await withRoute(async (app) => {
      const ownerKey = BrowserOwner.key({
        mode: "session",
        scopeID: ScopeContext.current.scope.id,
        sessionID: "session-route",
        directory: ScopeContext.current.directory,
      })
      const expired = BrowserNativeLease.issue(BrowserBroker.secret(), {
        ownerKey,
        serverOrigin: "http://localhost",
        now: 1,
      })
      const expiredResponse = await app.request(
        `/home/browser/session?mode=session&sessionID=session-route&presentation=native&nativeTicket=${encodeURIComponent(expired)}`,
      )
      expect(await expiredResponse.json()).toMatchObject({
        code: "browser_native_ticket_expired",
        retryable: true,
      })

      const wrongOrigin = BrowserNativeLease.issue(BrowserBroker.secret(), {
        ownerKey,
        serverOrigin: "https://wrong.example.com",
      })
      const originResponse = await app.request(
        `/home/browser/session?mode=session&sessionID=session-route&presentation=native&nativeTicket=${encodeURIComponent(wrongOrigin)}`,
      )
      expect(await originResponse.json()).toMatchObject({
        code: "browser_native_ticket_origin_mismatch",
        retryable: true,
      })
    })
  })

  test("selects native only with a matching ticket and registered native Host", async () => {
    await withRoute(async (app) => {
      const owner = {
        mode: "session" as const,
        scopeID: ScopeContext.current.scope.id,
        sessionID: "session-route",
        directory: ScopeContext.current.directory,
      }
      BrowserBroker.attach(new BrokerSocket(), {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "native-host-route",
        token: BrowserBroker.secret(),
        capabilities: { native: true, webrtc: true },
      })
      const ticket = BrowserNativeLease.issue(BrowserBroker.secret(), {
        ownerKey: BrowserOwner.key(owner),
        serverOrigin: "http://localhost",
      })
      const response = await app.request(
        `/home/browser/session?mode=session&sessionID=session-route&presentation=native&nativeTicket=${encodeURIComponent(ticket)}`,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ presentation: { kind: "native", reason: "requested" } })
    })
  })

  test("GET session exposes a suspended descriptor without starting a page", async () => {
    await withRoute(async (app) => {
      const response = await app.request(
        "/home/browser/session?mode=session&sessionID=session-route&presentation=webrtc",
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        type: "session.state",
        protocolVersion: 2,
        ownerKey: expect.any(String),
        status: "suspended",
        page: { id: "page-1", url: "https://example.com/" },
      })
    })
  })

  test("does not issue a viewer ticket for a suspended descriptor", async () => {
    await withRoute(async (app) => {
      const response = await app.request("/home/browser/webrtc/ticket?mode=session&sessionID=session-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 2, pageId: "page-1" }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ type: "error", code: "browser_ticket_page_unavailable" })
    })
  })

  test("renews missing Host signaling when a viewer requests a broker-owned page", async () => {
    await withRoute(async (app) => {
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID: ScopeContext.current.scope.id,
        sessionID: "session-route",
        directory: ScopeContext.current.directory,
      }
      const broker = new BrokerSocket()
      BrowserBroker.attach(broker, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host-route",
        token: BrowserBroker.secret(),
        capabilities: { native: false, webrtc: true },
      })
      await BrowserBroker.createPage({
        owner,
        routeDirectory: "home",
        presentation: "webrtc",
        pageId: "page-1",
      })
      broker.sent = []

      const response = await app.request("/home/browser/webrtc/ticket?mode=session&sessionID=session-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: BROWSER_PROTOCOL_VERSION, pageId: "page-1" }),
      })

      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toMatchObject({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ticket: expect.any(String),
      })
      expect(broker.sent).toContainEqual({
        type: "page.signaling.ticket",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey: BrowserOwner.key(owner),
        pageId: "page-1",
        signalingTicket: expect.any(String),
      })
    }, active)
  })

  test("does not renew Host signaling when a viewer requests an attached Host page", async () => {
    await withRoute(async (app) => {
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID: ScopeContext.current.scope.id,
        sessionID: "session-route",
        directory: ScopeContext.current.directory,
      }
      const broker = new BrokerSocket()
      BrowserBroker.attach(broker, {
        type: "host.register",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        hostId: "host-route",
        token: BrowserBroker.secret(),
        capabilities: { native: false, webrtc: true },
      })
      await BrowserBroker.createPage({
        owner,
        routeDirectory: "home",
        presentation: "webrtc",
        pageId: "page-1",
      })
      BrowserWebRTCSignaling.attachHost(owner, "page-1", new SignalingSocket(), { hostReady: true })
      broker.sent = []

      const response = await app.request("/home/browser/webrtc/ticket?mode=session&sessionID=session-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: BROWSER_PROTOCOL_VERSION, pageId: "page-1" }),
      })

      expect(response.status, await response.clone().text()).toBe(200)
      expect(broker.sent).toHaveLength(0)
    }, active)
  })

  test("allows only the Host to attach while its broker page is reserved for creation", () => {
    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "home",
      sessionID: "session-route",
      directory: "/workspace",
    }
    const session = suspended(owner)

    expect(browserSignalingPageAvailable("host", "page-1", session, true)).toBe(true)
    expect(browserSignalingPageAvailable("viewer", "page-1", session, true)).toBe(false)
    expect(browserSignalingPageAvailable("host", "page-1", session, false)).toBe(false)
  })

  test("renews signaling only when the current Host socket closes for a broker-owned page", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner: BrowserOwner.Info = {
          mode: "session",
          scopeID: ScopeContext.current.scope.id,
          sessionID: "session-route",
          directory: ScopeContext.current.directory,
        }
        restoreRuntime = BrowserCommandService.useRuntimeForTest({
          async getOrCreateSession() {
            return suspended(owner)
          },
        })
        const broker = new BrokerSocket()
        BrowserBroker.attach(broker, {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "host-route",
          token: BrowserBroker.secret(),
          capabilities: { native: false, webrtc: true },
        })
        await BrowserBroker.createPage({
          owner,
          routeDirectory: "home",
          presentation: "webrtc",
          pageId: "page-1",
        })
        const created = broker.sent.find(
          (message): message is Extract<BrowserHostMessage, { type: "page.create" }> => message.type === "page.create",
        )
        expect(created?.signalingTicket).toBeDefined()

        const firstHandlers = createBrowserSignalingSocket(signalingContext(created!.signalingTicket!), "host")
        const firstSocket = new SignalingSocket()
        await firstHandlers.onOpen(undefined, firstSocket)

        const replacementTicket = BrowserTicket.issue(owner, "page-1", "host")
        const secondHandlers = createBrowserSignalingSocket(signalingContext(replacementTicket.ticket), "host")
        const secondSocket = new SignalingSocket()
        await secondHandlers.onOpen(undefined, secondSocket)

        const renewalMessages = () =>
          broker.sent.filter(
            (message): message is Extract<BrowserHostMessage, { type: "page.signaling.ticket" }> =>
              message.type === "page.signaling.ticket",
          )

        broker.sent = []
        firstHandlers.onClose()
        expect(renewalMessages()).toHaveLength(0)

        secondHandlers.onClose()
        const renewals = renewalMessages()
        expect(renewals).toHaveLength(1)
        expect(renewals[0]).toMatchObject({
          ownerKey: BrowserOwner.key(owner),
          pageId: "page-1",
        })
        expect(renewals[0].signalingTicket).toBeDefined()
        expect(() => BrowserTicket.consume(owner, "page-1", "host", renewals[0].signalingTicket)).not.toThrow()
        expect(() => BrowserTicket.consume(owner, "page-1", "host", renewals[0].signalingTicket)).toThrow(/invalid/i)
      },
    })
  })

  test("accepts the file controller origin without accepting web-page Host connections", () => {
    expect(browserHostOriginAllowed(undefined)).toBe(true)
    expect(browserHostOriginAllowed("file://")).toBe(true)
    expect(browserHostOriginAllowed("http://127.0.0.1:3000")).toBe(false)
    expect(browserHostOriginAllowed("https://example.com")).toBe(false)
  })

  test("requires explicit authorization for non-matching viewer origins", () => {
    configureBrowserViewerOrigins([])

    expect(
      browserViewerOriginAllowed({
        origin: "https://attacker.example.com",
        requestURL: "http://127.0.0.1:4096/home/browser/events",
      }),
    ).toBe(false)
  })

  test("uses configured server CORS origins for Browser viewer sockets", () => {
    configureBrowserViewerOrigins(["https://browser.example.com"])

    expect(
      browserViewerOriginAllowed({
        origin: "https://browser.example.com",
        requestURL: "http://127.0.0.1:4096/home/browser/events",
      }),
    ).toBe(true)
  })

  test("keeps the registered socket identity across websocket event wrappers", () => {
    const registered = { send() {}, close() {} }
    const eventWrapper = { send() {}, close() {} }

    expect(browserSignalingEventSocket(registered, eventWrapper)).toBe(registered)
    expect(browserSignalingEventSocket(undefined, eventWrapper)).toBeUndefined()
  })

  test("rejects an oversized Browser body using its actual streamed bytes", async () => {
    await withRoute(async (app) => {
      const response = await app.request("/home/browser/webrtc/ticket?mode=session&sessionID=session-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 2, pageId: "page-1", padding: "x".repeat(20 * 1024) }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ type: "error", code: "browser_payload_too_large" })
    })
  })

  test("GET session preserves a recoverable failed descriptor and structured reason", async () => {
    await withRoute(
      async (app) => {
        const response = await app.request(
          "/home/browser/session?mode=session&sessionID=session-route&presentation=webrtc",
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          type: "session.state",
          status: "failed",
          page: { id: "page-1" },
          error: { type: "error", code: "browser_host_unavailable", retryable: true },
        })
      },
      (owner) => ({
        ...suspended(owner),
        status: "failed",
        error: {
          type: "error",
          code: "browser_host_unavailable",
          message: "Browser Host is unavailable.",
          retryable: true,
        },
      }),
    )
  })

  test("requires commandId before any browser side effect", async () => {
    await withRoute(async (app) => {
      const response = await app.request("/home/browser/control?mode=session&sessionID=session-route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: { type: "reload" } }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ type: "error", code: "browser_command_id_required" })
    })
  })

  test("rejects pageId, evaluate, CDP, and unknown fields in UI control commands", async () => {
    await withRoute(async (app) => {
      for (const command of [
        { type: "reload", pageId: "page-1" },
        { type: "evaluate", expression: "document.cookie" },
        { type: "cdp", method: "Runtime.evaluate" },
        { type: "navigate", url: "https://example.com", unexpected: true },
      ]) {
        const response = await app.request("/home/browser/control?mode=session&sessionID=session-route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: crypto.randomUUID(), command }),
        })
        expect(response.status, await response.clone().text()).toBe(400)
        expect((await response.json()).type).toBe("error")
      }
    })
  })
})
