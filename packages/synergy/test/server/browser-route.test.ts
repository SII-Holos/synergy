import { afterEach, describe, expect, test } from "bun:test"
import { BrowserCommandService } from "../../src/browser/command-service"
import type { BrowserOwner } from "../../src/browser/owner"
import type { BrowserSession } from "../../src/browser/types"
import {
  browserHostOriginAllowed,
  browserSignalingEventSocket,
  browserSignalingPageAvailable,
} from "../../src/server/browser-route"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

let restoreRuntime: (() => void) | undefined
afterEach(() => {
  restoreRuntime?.()
  restoreRuntime = undefined
  BrowserCommandService.clear()
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

  test("accepts the file controller origin without accepting web-page Host connections", () => {
    expect(browserHostOriginAllowed(undefined)).toBe(true)
    expect(browserHostOriginAllowed("file://")).toBe(true)
    expect(browserHostOriginAllowed("http://127.0.0.1:3000")).toBe(false)
    expect(browserHostOriginAllowed("https://example.com")).toBe(false)
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
