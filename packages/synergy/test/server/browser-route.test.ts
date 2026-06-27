import { describe, expect, test } from "bun:test"
import { BrowserHost } from "../../src/browser/host"
import { BrowserHostControl } from "../../src/browser/host-control"
import { BrowserOwner } from "../../src/browser/owner"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

function fakeSession(owner: BrowserOwner.Info, activeTabId: string) {
  let currentActiveTabId = activeTabId
  let tabs = [
    {
      id: "tab_google",
      url: "https://www.google.com/",
      title: "Google",
      loading: false,
      pinned: false,
      kept: false,
      lastActiveAt: null,
    },
    {
      id: "tab_blank",
      url: "about:blank",
      title: "about:blank",
      loading: false,
      pinned: false,
      kept: false,
      lastActiveAt: null,
    },
  ]
  return {
    owner,
    get tabs() {
      return tabs
    },
    get activeTab() {
      return tabs.find((tab) => tab.id === currentActiveTabId) ?? null
    },
    annotations: [],
    async createTab() {
      throw new Error("unexpected createTab")
    },
    switchTab(tabId: string) {
      if (!tabs.some((tab) => tab.id === tabId)) throw new Error(`Browser tab not found: ${tabId}`)
      currentActiveTabId = tabId
    },
    async closeTab(tabId: string) {
      tabs = tabs.filter((tab) => tab.id !== tabId)
      if (currentActiveTabId === tabId) currentActiveTabId = tabs[0]?.id ?? ""
    },
    async closeOthers() {},
    getTab(id: string) {
      return tabs.find((tab) => tab.id === id)
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
    async notifyTabNavigated() {},
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
    owner,
    tabs: [],
    activeTab: null,
    annotations: [],
    async createTab() {
      throw new Error("unexpected createTab")
    },
    switchTab() {
      throw new Error("unexpected switchTab")
    },
    async closeTab() {},
    async closeOthers() {},
    getTab() {
      return undefined
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
    async notifyTabNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async dispose() {},
  } as any
}

describe("BrowserRoute control readiness", () => {
  test("reads browser session state without creating an initial tab", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_empty",
          mode: "session",
        })
        const session = fakeEmptySession(owner)
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return session
          },
        })

        try {
          const app = Server.App()
          const response = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_route_empty&presentation=webrtc&client=web&scopeID=home",
          )

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.tabs).toEqual([])
          expect(body.activeTabId).toBeNull()
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
        const app = Server.App()
        const response = await app.request(
          "/home/browser/control?mode=session&sessionID=ses_route&presentation=webrtc&client=web&scopeID=home",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-synergy-browser-trace": "browser_trace_route",
            },
            body: JSON.stringify({
              commandId: "browser_cmd_route",
              command: {
                type: "navigate",
                tabId: "tab_missing",
                url: "https://example.com/",
                source: "user",
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
          tabId: "tab_missing",
          commandId: "browser_cmd_route",
          commandType: "navigate",
        })
      },
    })
  })

  test("uses canonical session activation for WebRTC session state", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_merge",
          mode: "session",
        })
        const session = fakeSession(owner, "tab_google")
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return session
          },
        })

        try {
          const google = { send() {}, close() {} }
          const blank = { send() {}, close() {} }
          const googleConnection = BrowserHostControl.attach(owner, google, { tabId: "tab_google" })
          const blankConnection = BrowserHostControl.attach(owner, blank, { tabId: "tab_blank" })
          googleConnection.handleMessage({
            type: "browser.host.ready",
            session: {
              tabs: [
                {
                  id: "tab_google",
                  url: "https://www.google.com/",
                  title: "Google Host",
                  isLoading: false,
                  pinned: false,
                  kept: false,
                  lastActiveAt: null,
                },
              ],
              activeTabId: "tab_google",
            },
          })
          blankConnection.handleMessage({
            type: "browser.host.ready",
            session: {
              tabs: [
                {
                  id: "tab_blank",
                  url: "about:blank",
                  title: "Blank Host",
                  isLoading: false,
                  pinned: false,
                  kept: false,
                  lastActiveAt: null,
                },
              ],
              activeTabId: "tab_blank",
            },
          })

          const app = Server.App()
          const response = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_route_merge&presentation=webrtc&client=web&scopeID=home",
          )

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.activeTabId).toBe("tab_google")
          expect(body.tabs).toEqual([
            expect.objectContaining({ id: "tab_google", title: "Google Host" }),
            expect.objectContaining({ id: "tab_blank", title: "Blank Host" }),
          ])
        } finally {
          BrowserHostControl.resetForTest()
          restore()
        }
      },
    })
  })

  test("keeps WebRTC tab activation in the canonical session", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owner = BrowserOwner.fromRoute({
          directory: ScopeContext.current.directory,
          scopeID: ScopeContext.current.scope.id,
          sessionID: "ses_route_switch",
          mode: "session",
        })
        const session = fakeSession(owner, "tab_google")
        const restore = BrowserHost.useRuntimeForTest({
          async ensure() {},
          async health() {
            return { running: false, chromiumPath: null, installed: false, version: null }
          },
          async getOrCreateSession() {
            return session
          },
        })

        try {
          const sentHostMessages: string[] = []
          const blankConnection = BrowserHostControl.attach(
            owner,
            {
              send(data: string) {
                sentHostMessages.push(data)
              },
              close() {},
            },
            { tabId: "tab_blank" },
          )
          blankConnection.handleMessage({
            type: "browser.host.ready",
            session: {
              tabs: [
                {
                  id: "tab_blank",
                  url: "about:blank",
                  title: "Blank Host",
                  isLoading: false,
                  pinned: false,
                  kept: false,
                  lastActiveAt: null,
                },
              ],
              activeTabId: "tab_blank",
            },
          })

          const app = Server.App()
          const response = await app.request(
            "/home/browser/control?mode=session&sessionID=ses_route_switch&presentation=webrtc&client=web&scopeID=home",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                commandId: "browser_cmd_switch",
                command: { type: "switchTab", tabId: "tab_blank" },
              }),
            },
          )

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.result).toMatchObject({ type: "tab", tab: { id: "tab_blank" } })
          expect(sentHostMessages).toEqual([])

          const sessionResponse = await app.request(
            "/home/browser/session?mode=session&sessionID=ses_route_switch&presentation=webrtc&client=web&scopeID=home",
          )
          const sessionBody = await sessionResponse.json()
          expect(sessionBody.activeTabId).toBe("tab_blank")
          expect(sessionBody.tabs).toEqual([
            expect.objectContaining({ id: "tab_google", title: "Google" }),
            expect.objectContaining({ id: "tab_blank", title: "Blank Host" }),
          ])
        } finally {
          BrowserHostControl.resetForTest()
          restore()
        }
      },
    })
  })
})
