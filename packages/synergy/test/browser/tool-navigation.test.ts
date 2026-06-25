import { describe, expect, test } from "bun:test"
import { BrowserToolHelper, BrowserTabNotFoundError } from "../../src/tool/browser-shared"
import { BrowserControl } from "../../src/browser/control"
import { BrowserHost } from "../../src/browser/host"
import { BlockedURLNavigationError, type BrowserTab } from "../../src/browser/tab"
import type { BrowserSession } from "../../src/browser/types"
import type { Tool } from "../../src/tool/tool"

function tab(id: string): BrowserTab {
  return {
    id,
    url: "",
    title: "",
    loading: false,
    pinned: false,
    kept: false,
    lastActiveAt: null,
    cdp: null,
    async navigate(url: string) {
      return { url, title: "" }
    },
    async navigateForUser(url: string) {
      return { url, title: "" }
    },
    async navigateWithOverride(url: string) {
      return { url, title: "" }
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
    async startFrameStream() {},
    async stopFrameStream() {},
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

function ctx(asks: unknown[]): Tool.Context {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask(input) {
      asks.push(input)
    },
  }
}

describe("browser tool navigation helpers", () => {
  test("resolveOrCreateTab creates a tab when no active tab exists", async () => {
    const created = tab("created")
    let createCalls = 0

    const resolved = await BrowserToolHelper.resolveOrCreateTab({
      activeTab: null,
      getTab() {
        return undefined
      },
      async createTab() {
        createCalls++
        return created
      },
    })

    expect(resolved).toBe(created)
    expect(createCalls).toBe(1)
  })

  test("resolveOrCreateTab throws for a missing explicit tab id", async () => {
    await expect(
      BrowserToolHelper.resolveOrCreateTab(
        {
          activeTab: tab("active"),
          getTab() {
            return undefined
          },
          async createTab() {
            return tab("created")
          },
        },
        "missing",
      ),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError)
  })

  test("navigateWithPolicyApproval asks and retries blocked URLs with override", async () => {
    const asks: unknown[] = []
    const visited: string[] = []
    const fakeTab = {
      ...tab("tab-1"),
      async navigate() {
        throw new BlockedURLNavigationError("Public URL requires approval", "https://www.google.com/")
      },
      async navigateWithOverride(url: string) {
        visited.push(url)
        return { url, title: "Google" }
      },
    }

    const result = await BrowserToolHelper.navigateWithPolicyApproval(ctx(asks), fakeTab, "https://www.google.com")

    expect(asks).toHaveLength(1)
    expect(visited).toEqual(["https://www.google.com/"])
    expect(result).toEqual({ url: "https://www.google.com/", title: "Google" })
  })
})

describe("BrowserControl", () => {
  function controlSession(fakeTab: BrowserTab): BrowserSession {
    return {
      owner: {
        directory: "/tmp/synergy",
        scopeID: "scope",
        sessionID: "ses_test",
        mode: "session",
      },
      tabs: [fakeTab],
      activeTab: fakeTab,
      annotations: [],
      async createTab() {
        return fakeTab
      },
      switchTab() {},
      async closeTab() {},
      async closeOthers() {},
      getTab(id: string) {
        return id === fakeTab.id ? fakeTab : undefined
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
    }
  }

  test("executes navigation through the shared control interface", async () => {
    const fakeTab = {
      ...tab("tab-1"),
      async navigateForUser(url: string) {
        fakeTab.url = `${url}/`
        fakeTab.title = "Example"
        return { url: fakeTab.url, title: fakeTab.title }
      },
    }
    const saved: string[] = []
    const notified: string[] = []
    const session = {
      ...controlSession(fakeTab),
      async save() {
        saved.push("save")
      },
      async notifyTabNavigated(tab: BrowserTab) {
        notified.push(tab.id)
      },
    }

    const result = await BrowserControl.execute(session, {
      type: "navigate",
      source: "user",
      tabId: "tab-1",
      url: "https://example.com",
    })

    expect(result).toEqual({
      type: "navigation",
      tab: {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example",
        isLoading: false,
        pinned: false,
        kept: false,
        lastActiveAt: null,
      },
      url: "https://example.com/",
      title: "Example",
    })
    expect(saved).toEqual(["save"])
    expect(notified).toEqual(["tab-1"])
  })

  test("executes input and diagnostic commands through the shared control interface", async () => {
    const mouseActions: unknown[] = []
    const keyActions: unknown[] = []
    const inserted: string[] = []
    let cleared = false
    const fakeTab = {
      ...tab("tab-2"),
      async dispatchMouse(action: "move" | "down" | "up" | "wheel", input: unknown) {
        mouseActions.push({ action, input })
      },
      async dispatchKey(action: "down" | "up", input: unknown) {
        keyActions.push({ action, input })
      },
      async insertText(text: string) {
        inserted.push(text)
      },
      async consoleEntries() {
        return [{ type: "log", text: "hello", timestamp: 1 }]
      },
      async networkRequests() {
        return [
          {
            requestId: "req-1",
            url: "https://example.com/image.png",
            method: "GET",
            mimeType: "image/png",
            timestamp: 1,
          },
        ]
      },
      async screenshot() {
        return { buffer: Buffer.from("ok"), width: 10, height: 20 }
      },
      async clearDiagnostics() {
        cleared = true
      },
    }
    const session = controlSession(fakeTab)

    await BrowserControl.execute(session, {
      type: "mouse",
      tabId: "tab-2",
      action: "wheel",
      input: { x: 5, y: 6, deltaX: 0, deltaY: 120 },
    })
    await BrowserControl.execute(session, {
      type: "key",
      tabId: "tab-2",
      action: "down",
      input: { key: "A", code: "KeyA" },
    })
    await BrowserControl.execute(session, { type: "insertText", tabId: "tab-2", text: "hi" })
    const consoleResult = await BrowserControl.execute(session, { type: "console", tabId: "tab-2" })
    const assetsResult = await BrowserControl.execute(session, { type: "assets", tabId: "tab-2" })
    const screenshotResult = await BrowserControl.execute(session, {
      type: "screenshot",
      tabId: "tab-2",
      format: "jpeg",
    })
    const clearedResult = await BrowserControl.execute(session, { type: "clearDiagnostics", tabId: "tab-2" })

    expect(mouseActions).toEqual([{ action: "wheel", input: { x: 5, y: 6, deltaX: 0, deltaY: 120 } }])
    expect(keyActions).toEqual([{ action: "down", input: { key: "A", code: "KeyA" } }])
    expect(inserted).toEqual(["hi"])
    expect(consoleResult).toEqual({
      type: "console",
      tabId: "tab-2",
      entries: [{ type: "log", text: "hello", timestamp: 1 }],
    })
    expect(assetsResult).toMatchObject({
      type: "assets",
      tabId: "tab-2",
      assets: [{ id: "req-1", type: "image", url: "https://example.com/image.png" }],
    })
    expect(screenshotResult).toEqual({
      type: "screenshot",
      tabId: "tab-2",
      dataUrl: `data:image/jpeg;base64,${Buffer.from("ok").toString("base64")}`,
      width: 10,
      height: 20,
    })
    expect(cleared).toBe(true)
    expect(clearedResult).toEqual({ type: "diagnostics.cleared", tabId: "tab-2" })
  })

  test("BrowserHost executes commands through its runtime-backed control adapter", async () => {
    let ensureCalls = 0
    const fakeTab = {
      ...tab("tab-3"),
      async networkRequests() {
        return [
          {
            requestId: "req-host",
            url: "https://example.com/app.js",
            method: "GET",
            mimeType: "text/javascript",
            timestamp: 10,
          },
        ]
      },
    }
    const session = controlSession(fakeTab)
    const restore = BrowserHost.useRuntimeForTest({
      async ensure() {
        ensureCalls++
      },
      async health() {
        return { running: true, chromiumPath: "/chromium", installed: true, version: "test" }
      },
      async getOrCreateSession(owner) {
        expect(owner).toEqual(session.owner)
        return session
      },
    })

    try {
      const result = await BrowserHost.execute(session.owner, { type: "network", tabId: "tab-3" })

      expect(ensureCalls).toBe(1)
      expect(result).toEqual({
        type: "network",
        tabId: "tab-3",
        requests: [
          {
            requestId: "req-host",
            url: "https://example.com/app.js",
            method: "GET",
            mimeType: "text/javascript",
            timestamp: 10,
          },
        ],
      })
    } finally {
      restore()
    }
  })
})
