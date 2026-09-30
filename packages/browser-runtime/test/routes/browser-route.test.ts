import { Session } from "@ericsanchezok/synergy-harness/session"
import { afterEach, describe, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserNativeLease } from "@ericsanchezok/synergy-browser-core/native-lease"
import { BrowserBroker, type BrowserBrokerSocket } from "../../src/broker"
import { BrowserCommandService } from "../../src/command-service"
import { BrowserNetworkGateway } from "../../src/network-gateway"
import { BrowserNativePresentation } from "../../src/native-presentation"
import { BrowserOwner } from "../../src/owner"
import type { BrowserSession } from "../../src/types"
import {
  BrowserRoute,
  browserHostOriginAllowed,
  browserViewerOriginAllowed,
  configureBrowserViewerOrigins,
} from "../../src/routes/browser-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime(() =>
  Server.registerContributions({ routes: { "scoped-after-assets": BrowserRoute() } }),
)
await runtime.run(() =>
  ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ id: "ses_browser_route" }) }),
)

let restoreRuntime: (() => void) | undefined
afterEach(() =>
  runtime.run(async () => {
    restoreRuntime?.()
    restoreRuntime = undefined
    BrowserCommandService.clear()
    BrowserBroker.resetForTest()
    BrowserNativePresentation.resetForTest()
    configureBrowserViewerOrigins([])
    await BrowserNetworkGateway.stop()
  }),
)

function suspended(owner: BrowserOwner.Info): BrowserSession {
  return {
    owner,
    status: "suspended",
    pages: [
      {
        id: "page-1",
        url: "https://example.com/",
        title: "Example",
        lastActiveAt: 1,
        isLoading: false,
        status: "suspended",
        profileId: "personal",
      },
    ],
    annotations: [],
    async openPage() {
      throw new Error("A read-only route must not create a page.")
    },
    async resumePage() {
      throw new Error("A read-only route must not resume a page.")
    },
    async closePage() {},
    async suspendProfile() {},
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
    pages: [
      {
        id: page.id,
        url: page.url,
        title: page.title,
        lastActiveAt: 1,
        isLoading: false,
        status: "active",
        profileId: "personal",
      },
    ],
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
        sessionID: "ses_browser_route",
        directory: ScopeContext.current.workspace?.path ?? null,
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

describe("BrowserRoute protocol", () => {
  test("keeps an explicit native request strict when its ticket is missing", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const response = await app.request(
          "/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=native",
        )

        expect(response.status).toBe(500)
        expect(await response.json()).toMatchObject({
          type: "error",
          code: "browser_native_ticket_required",
          retryable: true,
        })
      })
    }))

  test("returns structured native ticket rejection without selecting WebRTC", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const ticket = BrowserNativeLease.issue(BrowserBroker.secret(), {
          ownerKey: "scope:wrong:session:owner",
          serverOrigin: "http://localhost",
        })
        const response = await app.request(
          `/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=native&nativeTicket=${encodeURIComponent(ticket)}`,
        )

        expect(response.status).toBe(500)
        expect(await response.json()).toMatchObject({
          type: "error",
          code: "browser_native_ticket_owner_mismatch",
          retryable: true,
        })
      })
    }))

  test("rejects expired and wrong-origin native tickets with stable retryable codes", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const ownerKey = BrowserOwner.key({
          mode: "session",
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_browser_route",
          directory: ScopeContext.current.workspace?.path ?? null,
        })
        const expired = BrowserNativeLease.issue(BrowserBroker.secret(), {
          ownerKey,
          serverOrigin: "http://localhost",
          now: 1,
        })
        const expiredResponse = await app.request(
          `/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=native&nativeTicket=${encodeURIComponent(expired)}`,
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
          `/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=native&nativeTicket=${encodeURIComponent(wrongOrigin)}`,
        )
        expect(await originResponse.json()).toMatchObject({
          code: "browser_native_ticket_origin_mismatch",
          retryable: true,
        })
      })
    }))

  test("selects native only with a matching ticket and registered native Host", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const owner = {
          mode: "session" as const,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_browser_route",
          directory: ScopeContext.current.workspace?.path ?? null,
        }
        BrowserBroker.attach(new BrokerSocket(), {
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "native-host-route",
          token: BrowserBroker.secret(),
          capabilities: { native: true },
        })
        const ticket = BrowserNativeLease.issue(BrowserBroker.secret(), {
          ownerKey: BrowserOwner.key(owner),
          serverOrigin: "http://localhost",
        })
        const response = await app.request(
          `/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=native&nativeTicket=${encodeURIComponent(ticket)}`,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ presentation: { kind: "native", reason: "requested" } })
      })
    }))

  test("GET session exposes a suspended descriptor without starting a page", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const response = await app.request(
          "/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=auto",
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          type: "session.state",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          ownerKey: expect.any(String),
          status: "suspended",
          pages: [{ id: "page-1", url: "https://example.com/" }],
        })
      })
    }))

  test("accepts the file controller origin without accepting web-page Host connections", () =>
    runtime.run(() => {
      expect(browserHostOriginAllowed(undefined)).toBe(true)
      expect(browserHostOriginAllowed("file://")).toBe(true)
      expect(browserHostOriginAllowed("http://127.0.0.1:3000")).toBe(false)
      expect(browserHostOriginAllowed("https://example.com")).toBe(false)
    }))

  test("requires explicit authorization for non-matching viewer origins", () =>
    runtime.run(() => {
      configureBrowserViewerOrigins([])

      expect(
        browserViewerOriginAllowed({
          origin: "https://attacker.example.com",
          requestURL: "http://127.0.0.1:4096/home/browser/events",
        }),
      ).toBe(false)
    }))

  test("uses configured server CORS origins for Browser viewer sockets", () =>
    runtime.run(() => {
      configureBrowserViewerOrigins(["https://browser.example.com"])

      expect(
        browserViewerOriginAllowed({
          origin: "https://browser.example.com",
          requestURL: "http://127.0.0.1:4096/home/browser/events",
        }),
      ).toBe(true)
    }))

  test("rejects an oversized Browser body using its actual streamed bytes", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const response = await app.request("/home/browser/pages?mode=session&sessionID=ses_browser_route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            pageId: "page-1",
            padding: "x".repeat(20 * 1024),
          }),
        })
        expect(response.status).toBe(413)
        expect(await response.json()).toMatchObject({ type: "error", code: "browser_payload_too_large" })
      })
    }))

  test("GET session preserves a recoverable failed descriptor and structured reason", () =>
    runtime.run(async () => {
      await withRoute(
        async (app) => {
          const response = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_browser_route&presentation=auto",
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({
            type: "session.state",
            status: "failed",
            pages: [
              {
                id: "page-1",
                status: "failed",
                error: { type: "error", code: "browser_host_unavailable", retryable: true },
              },
            ],
          })
        },
        (owner) => ({
          ...suspended(owner),
          status: "failed",
          pages: [
            {
              ...suspended(owner).pages[0]!,
              status: "failed",
              error: {
                type: "error",
                code: "browser_host_unavailable",
                message: "Browser Host is unavailable.",
                retryable: true,
              },
            },
          ],
        }),
      )
    }))

  test("requires commandId before any browser side effect", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        const response = await app.request("/home/browser/control?mode=session&sessionID=ses_browser_route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: { type: "reload" } }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ type: "error", code: "browser_command_id_required" })
      })
    }))

  test("rejects pageId, evaluate, CDP, and unknown fields in UI control commands", () =>
    runtime.run(async () => {
      await withRoute(async (app) => {
        for (const command of [
          { type: "reload", pageId: "page-1" },
          { type: "evaluate", expression: "document.cookie" },
          { type: "cdp", method: "Runtime.evaluate" },
          { type: "navigate", url: "https://example.com", unexpected: true },
        ]) {
          const response = await app.request("/home/browser/control?mode=session&sessionID=ses_browser_route", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId: crypto.randomUUID(), command }),
          })
          expect(response.status, await response.clone().text()).toBe(400)
          expect((await response.json()).type).toBe("error")
        }
      })
    }))
})

afterRuntimeTests(() => runtime.close())
