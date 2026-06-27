import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHost } from "../../src/browser/host"
import { BrowserHostControl } from "../../src/browser/host-control"
import { BrowserOwner } from "../../src/browser/owner"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

function fakePage(id: string, url = "https://www.google.com/") {
  return {
    id,
    url,
    title: "Google",
    loading: false,
    pinned: false,
    kept: false,
    lastActiveAt: null,
    async navigate() {
      throw new Error("runtime page should not navigate in this test")
    },
    async navigateForUser() {
      throw new Error("runtime page should not navigate in this test")
    },
    async navigateWithOverride() {
      throw new Error("runtime page should not navigate in this test")
    },
    async reload() {},
    async goBack() {},
    async goForward() {},
    async stop() {},
    async setViewport() {},
    async click() {},
    async type() {},
    async scroll() {},
    async dispatchMouse() {},
    async dispatchKey() {},
    async insertText() {},
    async respondToFileChooser() {},
    async respondToDialog() {},
    async ensureCDP() {
      throw new Error("not implemented")
    },
    async detachCDP() {},
    async screenshot() {
      return { buffer: Buffer.alloc(0), width: 0, height: 0 }
    },
    async snapshot() {
      return { elements: [], truncated: false }
    },
    async consoleEntries() {
      return []
    },
    async networkRequests() {
      return []
    },
    async clearDiagnostics() {},
    async resolveRef() {
      return null
    },
    async evaluate() {
      return null
    },
    async waitFor() {
      return true
    },
    async close() {},
  }
}

function fakeSession(owner: BrowserOwner.Info, page = fakePage("page_google")) {
  let currentPage = page
  return {
    owner,
    get page() {
      return currentPage
    },
    annotations: [],
    async ensurePage() {
      return currentPage
    },
    async closePage() {
      currentPage = null as any
    },
    getPage(id: string) {
      return currentPage?.id === id ? currentPage : undefined
    },
    addAnnotation() {
      throw new Error("not implemented")
    },
    removeAnnotation() {
      return false
    },
    clearAnnotations() {},
    formatAnnotationsForContext() {
      return ""
    },
    addObserver() {
      return () => {}
    },
    async notifyPageNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async dispose() {},
  } as any
}

function fakeEmptySession(owner: BrowserOwner.Info) {
  return {
    ...fakeSession(owner),
    get page() {
      return null
    },
    async ensurePage() {
      throw new Error("GET /browser/session must not create a page")
    },
    getPage() {
      return undefined
    },
  } as any
}

describe("BrowserRoute control readiness", () => {
  afterEach(() => {
    BrowserHostControl.resetForTest()
  })

  test("reads browser session state without creating an initial page", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_empty",
          mode: "session",
        })
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return fakeEmptySession(owner)
          },
        })

        try {
          const app = Server.App()
          const response = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_route_empty&presentation=webrtc&client=web&scopeID=home",
          )

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.page).toBeNull()
        } finally {
          restore()
        }
      },
    })
  })

  test("returns a retryable pending response instead of 500 when WebRTC host control is not ready", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_pending",
          mode: "session",
        })
        BrowserHostControl.markStatus(owner, "page_google", "pending", { traceId: "browser_trace_route" })
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return fakeSession(owner)
          },
        })

        try {
          const app = Server.App()
          const response = await app.request(
            "/home/browser/control?mode=session&sessionID=ses_route_pending&presentation=webrtc&client=web&scopeID=home",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-synergy-browser-trace": "browser_trace_route",
              },
              body: JSON.stringify({
                commandId: "browser_cmd_route",
                command: {
                  type: "reload",
                  pageId: "page_google",
                },
              }),
            },
          )

          expect(response.status).toBe(409)
          const body = await response.json()
          expect(body).toMatchObject({
            type: "error",
            code: "browser_host_pending",
            retryable: true,
            traceId: "browser_trace_route",
            pageId: "page_google",
            commandId: "browser_cmd_route",
            commandType: "reload",
          })
        } finally {
          restore()
        }
      },
    })
  })

  test("ignores mismatched WebRTC host page state when reading the canonical session", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_merge",
          mode: "session",
        })
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return fakeSession(owner)
          },
        })

        try {
          const blank = { send() {}, close() {} }
          const blankConnection = BrowserHostControl.attach(owner, blank, { pageId: "page_blank" })
          blankConnection.handleMessage({
            type: "browser.host.ready",
            session: {
              page: {
                id: "page_blank",
                url: "about:blank",
                title: "Blank Host",
                isLoading: false,
                lastActiveAt: null,
              },
            },
          })

          const app = Server.App()
          const response = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_route_merge&presentation=webrtc&client=web&scopeID=home",
          )

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.page).toMatchObject({ id: "page_google", title: "Google" })
        } finally {
          restore()
        }
      },
    })
  })

  test("sends navigate to a ready WebRTC host for the existing page", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_navigate",
          mode: "session",
        })
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return fakeSession(owner)
          },
        })

        try {
          const sentHostMessages: string[] = []
          const connection = BrowserHostControl.attach(
            owner,
            {
              send(data: string) {
                sentHostMessages.push(data)
              },
              close() {},
            },
            { pageId: "page_google" },
          )
          connection.handleMessage({
            type: "browser.host.ready",
            session: {
              page: {
                id: "page_google",
                url: "https://www.google.com/",
                title: "Google",
                isLoading: false,
                lastActiveAt: null,
              },
            },
          })

          const app = Server.App()
          const responsePromise = app.request(
            "/home/browser/control?mode=session&sessionID=ses_route_navigate&presentation=webrtc&client=web&scopeID=home",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                commandId: "browser_cmd_navigate",
                command: { type: "navigate", pageId: "page_google", url: "www.google.com/search?q=synergy" },
              }),
            },
          )

          for (let attempt = 0; attempt < 10 && sentHostMessages.length === 0; attempt++) {
            await Promise.resolve()
          }
          const request = sentHostMessages.map((message) => JSON.parse(message)).find((message) => message.id)
          expect(request).toMatchObject({
            type: "browser.host.command",
            command: { type: "navigate", pageId: "page_google", url: "https://www.google.com/search?q=synergy" },
          })
          connection.handleMessage({
            type: "browser.host.result",
            id: request.id,
            result: {
              type: "navigation",
              url: "https://www.google.com/search?q=synergy",
              title: "Google Search",
              page: {
                id: "page_google",
                url: "https://www.google.com/search?q=synergy",
                title: "Google Search",
                isLoading: false,
                lastActiveAt: null,
              },
            },
          })

          const response = await responsePromise
          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.result).toMatchObject({
            type: "navigation",
            page: { id: "page_google", title: "Google Search" },
          })
        } finally {
          restore()
        }
      },
    })
  })
})
