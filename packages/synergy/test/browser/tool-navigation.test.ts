import { describe, expect, test } from "bun:test"
import { BrowserControl } from "../../src/browser/control"
import { BrowserHost } from "../../src/browser/host"
import { BlockedURLNavigationError, type BrowserTab } from "../../src/browser/tab"
import type { BrowserSession } from "../../src/browser/types"
import { BrowserPageNotFoundError, BrowserToolHelper } from "../../src/tool/browser-shared"
import type { Tool } from "../../src/tool/tool"

function page(id: string): BrowserTab {
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

function controlSession(fakePage: BrowserTab | null): BrowserSession {
  return {
    owner: {
      directory: "/tmp/synergy",
      scopeID: "scope",
      sessionID: "ses_test",
      mode: "session",
    },
    get page() {
      return fakePage
    },
    annotations: [],
    async ensurePage() {
      if (!fakePage) fakePage = page("created")
      return fakePage
    },
    async closePage() {
      fakePage = null
    },
    getPage(id: string) {
      return fakePage?.id === id ? fakePage : undefined
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
  }
}

describe("browser tool navigation helpers", () => {
  test("resolveOrCreatePage creates a page when no session page exists", async () => {
    const created = page("created")
    let createCalls = 0

    const resolved = await BrowserToolHelper.resolveOrCreatePage({
      page: null,
      getPage() {
        return undefined
      },
      async ensurePage() {
        createCalls++
        return created
      },
    })

    expect(resolved).toBe(created)
    expect(createCalls).toBe(1)
  })

  test("resolveOrCreatePage throws for a missing explicit page id", async () => {
    await expect(
      BrowserToolHelper.resolveOrCreatePage(
        {
          page: page("active"),
          getPage() {
            return undefined
          },
          async ensurePage() {
            return page("created")
          },
        },
        "missing",
      ),
    ).rejects.toBeInstanceOf(BrowserPageNotFoundError)
  })

  test("navigateWithPolicyApproval asks and retries blocked URLs with override", async () => {
    const asks: unknown[] = []
    const visited: string[] = []
    const fakePage = {
      ...page("page-1"),
      async navigate() {
        throw new BlockedURLNavigationError("Public URL requires approval", "https://www.google.com/")
      },
      async navigateWithOverride(url: string) {
        visited.push(url)
        return { url, title: "Google" }
      },
    }

    const result = await BrowserToolHelper.navigateWithPolicyApproval(ctx(asks), fakePage, "https://www.google.com")

    expect(asks).toHaveLength(1)
    expect(visited).toEqual(["https://www.google.com/"])
    expect(result).toEqual({ url: "https://www.google.com/", title: "Google" })
  })
})

describe("BrowserControl", () => {
  test("executes navigation through the shared control interface", async () => {
    const fakePage = {
      ...page("page-1"),
      async navigateForUser(url: string) {
        fakePage.url = `${url}/`
        fakePage.title = "Example"
        return { url: fakePage.url, title: fakePage.title }
      },
    }
    const saved: string[] = []
    const notified: string[] = []
    const session = {
      ...controlSession(fakePage),
      async save() {
        saved.push("save")
      },
      async notifyPageNavigated(nextPage: BrowserTab) {
        notified.push(nextPage.id)
      },
    }

    const result = await BrowserControl.execute(session, {
      type: "navigate",
      source: "user",
      pageId: "page-1",
      url: "https://example.com",
    })

    expect(result).toEqual({
      type: "navigation",
      page: {
        id: "page-1",
        url: "https://example.com/",
        title: "Example",
        isLoading: false,
        lastActiveAt: null,
      },
      url: "https://example.com/",
      title: "Example",
    })
    expect(saved).toEqual(["save"])
    expect(notified).toEqual(["page-1"])
  })

  test("executes input and diagnostic commands through the shared control interface", async () => {
    const mouseActions: unknown[] = []
    const keyActions: unknown[] = []
    const inserted: string[] = []
    const clicks: unknown[] = []
    const typed: string[] = []
    const scrolled: unknown[] = []
    const evaluated: unknown[] = []
    let cleared = false
    const fakePage = {
      ...page("page-2"),
      async click(x: number, y: number) {
        clicks.push({ x, y })
      },
      async type(text: string) {
        typed.push(text)
      },
      async scroll(deltaX: number, deltaY: number) {
        scrolled.push({ deltaX, deltaY })
      },
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
      async resolveRef(ref: string) {
        return ref === "@e1" ? { backendNodeId: 1, x: 10, y: 20, width: 30, height: 40 } : null
      },
      async evaluate(expression: string) {
        evaluated.push(expression)
        return { ok: true }
      },
      async clearDiagnostics() {
        cleared = true
      },
    }
    const session = controlSession(fakePage)

    await BrowserControl.execute(session, {
      type: "mouse",
      pageId: "page-2",
      action: "wheel",
      input: { x: 5, y: 6, deltaX: 0, deltaY: 120 },
    })
    await BrowserControl.execute(session, {
      type: "key",
      pageId: "page-2",
      action: "down",
      input: { key: "A", code: "KeyA" },
    })
    await BrowserControl.execute(session, { type: "insertText", pageId: "page-2", text: "hi" })
    await BrowserControl.execute(session, { type: "click", pageId: "page-2", x: 9, y: 10 })
    await BrowserControl.execute(session, { type: "typeText", pageId: "page-2", text: "typed" })
    await BrowserControl.execute(session, { type: "scroll", pageId: "page-2", deltaX: 1, deltaY: 2 })
    const resolvedResult = await BrowserControl.execute(session, { type: "resolveRef", pageId: "page-2", ref: "@e1" })
    const evalResult = await BrowserControl.execute(session, {
      type: "evaluate",
      pageId: "page-2",
      expression: "(() => true)()",
    })
    const consoleResult = await BrowserControl.execute(session, { type: "console", pageId: "page-2" })
    const assetsResult = await BrowserControl.execute(session, { type: "assets", pageId: "page-2" })
    const screenshotResult = await BrowserControl.execute(session, {
      type: "screenshot",
      pageId: "page-2",
      format: "jpeg",
    })
    const clearedResult = await BrowserControl.execute(session, { type: "clearDiagnostics", pageId: "page-2" })

    expect(mouseActions).toEqual([{ action: "wheel", input: { x: 5, y: 6, deltaX: 0, deltaY: 120 } }])
    expect(keyActions).toEqual([{ action: "down", input: { key: "A", code: "KeyA" } }])
    expect(inserted).toEqual(["hi"])
    expect(clicks).toEqual([{ x: 9, y: 10 }])
    expect(typed).toEqual(["typed"])
    expect(scrolled).toEqual([{ deltaX: 1, deltaY: 2 }])
    expect(resolvedResult).toEqual({
      type: "resolvedRef",
      pageId: "page-2",
      ref: "@e1",
      box: { backendNodeId: 1, x: 10, y: 20, width: 30, height: 40 },
    })
    expect(evaluated).toEqual(["(() => true)()"])
    expect(evalResult).toEqual({ type: "evaluation", pageId: "page-2", value: { ok: true } })
    expect(consoleResult).toEqual({
      type: "console",
      pageId: "page-2",
      entries: [{ type: "log", text: "hello", timestamp: 1 }],
    })
    expect(assetsResult).toMatchObject({
      type: "assets",
      pageId: "page-2",
      assets: [{ id: "req-1", type: "image", url: "https://example.com/image.png" }],
    })
    expect(screenshotResult).toEqual({
      type: "screenshot",
      pageId: "page-2",
      dataUrl: `data:image/jpeg;base64,${Buffer.from("ok").toString("base64")}`,
      width: 10,
      height: 20,
    })
    expect(cleared).toBe(true)
    expect(clearedResult).toEqual({ type: "diagnostics.cleared", pageId: "page-2" })
  })

  test("BrowserHost executes commands through its runtime-backed control adapter", async () => {
    let ensureCalls = 0
    const fakePage = {
      ...page("page-3"),
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
    const session = controlSession(fakePage)
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
      const result = await BrowserHost.executeRuntime(session.owner, { type: "network", pageId: "page-3" })

      expect(ensureCalls).toBe(1)
      expect(result).toEqual({
        type: "network",
        pageId: "page-3",
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
