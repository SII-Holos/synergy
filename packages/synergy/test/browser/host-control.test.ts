import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHost } from "../../src/browser/host"
import {
  BrowserHostControl,
  BrowserHostControlNotAttachedError,
  type BrowserHostControlSocket,
} from "../../src/browser/host-control"
import { BrowserToolHelper } from "../../src/tool/browser-shared"
import type { BrowserOwner } from "../../src/browser/owner"

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "ses_host",
  mode: "session",
}

function socket() {
  const messages: Record<string, unknown>[] = []
  const peer: BrowserHostControlSocket = {
    send(data: string) {
      messages.push(JSON.parse(data))
    },
    close() {},
  }
  return { peer, messages }
}

describe("BrowserHostControl", () => {
  afterEach(() => {
    BrowserHostControl.resetForTest()
  })

  test("records host session state and resolves command results", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer)
    connection.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_1",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_1",
      },
    })

    expect(BrowserHostControl.sessionState(owner)?.activeTabId).toBe("tab_1")

    const resultPromise = BrowserHostControl.execute(owner, {
      type: "navigate",
      tabId: "tab_1",
      url: "https://example.com/docs",
    })
    const request = host.messages.find((message) => message.type === "browser.host.command")!

    expect(request).toMatchObject({
      type: "browser.host.command",
      command: { type: "navigate", tabId: "tab_1", url: "https://example.com/docs" },
    })

    connection.handleMessage({
      type: "browser.host.result",
      id: request.id,
      result: {
        type: "navigation",
        url: "https://example.com/docs",
        title: "Docs",
        tab: {
          id: "tab_1",
          url: "https://example.com/docs",
          title: "Docs",
          isLoading: false,
          pinned: false,
          kept: false,
          lastActiveAt: null,
        },
      },
    })

    await expect(resultPromise).resolves.toMatchObject({ type: "navigation", title: "Docs" })
  })

  test("forwards host events to owner observers", () => {
    const host = socket()
    const events: Record<string, unknown>[] = []
    const unsubscribe = BrowserHostControl.addObserver(owner, (event) => events.push(event))
    const connection = BrowserHostControl.attach(owner, host.peer)

    connection.handleMessage({
      type: "browser.host.event",
      event: { type: "page.loaded", tabId: "tab_1", url: "https://example.com/" },
    })

    unsubscribe()
    expect(events).toContainEqual({ type: "page.loaded", tabId: "tab_1", url: "https://example.com/" })
  })

  test("tracks host readiness and resolves ready waiters", async () => {
    const host = socket()
    const ready = BrowserHostControl.waitForReady(owner, "tab_1", 1_000)
    const connection = BrowserHostControl.attach(owner, host.peer, { tabId: "tab_1", traceId: "trace_1" })

    expect(BrowserHostControl.status(owner, "tab_1")).toBe("pending")
    expect(BrowserHostControl.isReady(owner, "tab_1")).toBe(false)

    connection.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_1",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_1",
      },
    })

    await expect(ready).resolves.toBe(connection)
    expect(BrowserHostControl.status(owner, "tab_1")).toBe("ready")
    expect(BrowserHostControl.isReady(owner, "tab_1")).toBe(true)
  })

  test("throws a typed error when no host can handle a command", async () => {
    await expect(BrowserHostControl.execute(owner, { type: "reload", tabId: "missing" })).rejects.toBeInstanceOf(
      BrowserHostControlNotAttachedError,
    )
  })

  test("merges takeover ready state but lets session state replace removed tabs", () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer)

    connection.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_1",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_1",
      },
    })
    connection.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_2",
            url: "https://example.org/",
            title: "Example Org",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_2",
      },
    })

    expect(BrowserHostControl.sessionState(owner)).toMatchObject({
      tabs: [{ id: "tab_1" }, { id: "tab_2" }],
      activeTabId: "tab_2",
    })

    connection.handleMessage({
      type: "browser.host.session",
      session: {
        tabs: [
          {
            id: "tab_2",
            url: "https://example.org/",
            title: "Example Org",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_2",
      },
    })

    expect(BrowserHostControl.sessionState(owner)).toMatchObject({
      tabs: [{ id: "tab_2" }],
      activeTabId: "tab_2",
    })
  })

  test("routes commands across per-tab Browser Host connections", async () => {
    const host1 = socket()
    const host2 = socket()
    const connection1 = BrowserHostControl.attach(owner, host1.peer, { tabId: "tab_1" })
    const connection2 = BrowserHostControl.attach(owner, host2.peer, { tabId: "tab_2" })

    connection1.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_1",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_1",
      },
    })
    connection2.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_2",
            url: "https://example.org/",
            title: "Example Org",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_2",
      },
    })

    expect(BrowserHostControl.sessionState(owner)).toMatchObject({
      tabs: [{ id: "tab_1" }, { id: "tab_2" }],
      activeTabId: "tab_2",
    })

    const navigatePromise = BrowserHostControl.execute(owner, {
      type: "navigate",
      tabId: "tab_1",
      url: "https://example.com/docs",
    })
    const navigateRequest = host1.messages.find((message) => message.type === "browser.host.command")!
    expect(navigateRequest).toMatchObject({ command: { type: "navigate", tabId: "tab_1" } })
    expect(host2.messages.find((message) => message.type === "browser.host.command")).toBeUndefined()
    connection1.handleMessage({
      type: "browser.host.result",
      id: navigateRequest.id,
      result: {
        type: "navigation",
        url: "https://example.com/docs",
        title: "Docs",
        tab: {
          id: "tab_1",
          url: "https://example.com/docs",
          title: "Docs",
          isLoading: false,
          pinned: false,
          kept: false,
          lastActiveAt: null,
        },
      },
    })
    await expect(navigatePromise).resolves.toMatchObject({ type: "navigation", tab: { id: "tab_1" } })

    const createPromise = BrowserHostControl.execute(owner, { type: "createTab", url: "https://example.net/" })
    const createRequest = host2.messages.find((message) => message.type === "browser.host.command")!
    expect(createRequest).toMatchObject({ command: { type: "createTab", url: "https://example.net/" } })
    connection2.handleMessage({
      type: "browser.host.result",
      id: createRequest.id,
      result: {
        type: "tab",
        tab: {
          id: "tab_3",
          url: "https://example.net/",
          title: "Example Net",
          isLoading: false,
          pinned: false,
          kept: false,
          lastActiveAt: null,
        },
      },
    })
    await expect(createPromise).resolves.toMatchObject({ type: "tab", tab: { id: "tab_3" } })
  })

  test("BrowserHost routes tab creation through an attached host", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer)
    const restore = BrowserHost.useRuntimeForTest({
      async ensure() {
        throw new Error("runtime should not be used when host is attached")
      },
      async health() {
        return { running: false, chromiumPath: null, installed: false, version: null }
      },
      async getOrCreateSession() {
        throw new Error("runtime should not be used when host is attached")
      },
    })

    try {
      const resultPromise = BrowserHost.executeAttached(owner, { type: "createTab", url: "https://example.com/" })
      const request = host.messages.find((message) => message.type === "browser.host.command")!

      expect(request).toMatchObject({
        type: "browser.host.command",
        command: { type: "createTab", url: "https://example.com/" },
      })

      connection.handleMessage({
        type: "browser.host.result",
        id: request.id,
        result: {
          type: "tab",
          tab: {
            id: "tab_2",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        },
      })

      await expect(resultPromise).resolves.toMatchObject({ type: "tab", tab: { id: "tab_2" } })
    } finally {
      restore()
    }
  })

  test("BrowserHost normalizes address-bar URLs before sending commands to an attached host", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer, { tabId: "tab_1" })
    const restore = BrowserHost.useRuntimeForTest({
      async ensure() {
        throw new Error("runtime should not be used when host is attached")
      },
      async health() {
        return { running: false, chromiumPath: null, installed: false, version: null }
      },
      async getOrCreateSession() {
        throw new Error("runtime should not be used when host is attached")
      },
    })

    try {
      const resultPromise = BrowserHost.executeAttached(owner, {
        type: "navigate",
        tabId: "tab_1",
        url: "www.google.com",
        source: "user",
      })
      const request = host.messages.find((message) => message.type === "browser.host.command")!

      expect(request).toMatchObject({
        type: "browser.host.command",
        command: { type: "navigate", tabId: "tab_1", url: "https://www.google.com" },
      })

      connection.handleMessage({
        type: "browser.host.result",
        id: request.id,
        result: {
          type: "navigation",
          url: "https://www.google.com/",
          title: "Google",
          tab: {
            id: "tab_1",
            url: "https://www.google.com/",
            title: "Google",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        },
      })

      await expect(resultPromise).resolves.toMatchObject({ type: "navigation", title: "Google" })
    } finally {
      restore()
    }
  })

  test("tool helpers resolve attached Browser Host tabs before runtime fallback", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer)
    connection.handleMessage({
      type: "browser.host.ready",
      session: {
        tabs: [
          {
            id: "tab_1",
            url: "https://example.com/",
            title: "Example",
            isLoading: false,
            pinned: false,
            kept: false,
            lastActiveAt: null,
          },
        ],
        activeTabId: "tab_1",
      },
    })
    const restore = BrowserHost.useRuntimeForTest({
      async ensure() {
        throw new Error("runtime should not be used when host is attached")
      },
      async health() {
        return { running: false, chromiumPath: null, installed: false, version: null }
      },
      async getOrCreateSession() {
        throw new Error("runtime should not be used when host is attached")
      },
    })

    try {
      const tab = await BrowserToolHelper.getTab(owner)
      expect(tab.id).toBe("tab_1")
      expect(tab.page).toBeUndefined()

      const screenshotPromise = tab.screenshot("png")
      const request = host.messages.find(
        (message) =>
          message.type === "browser.host.command" && (message.command as { type?: string }).type === "screenshot",
      )!
      expect(request).toMatchObject({
        command: { type: "screenshot", tabId: "tab_1", format: "png" },
      })
      connection.handleMessage({
        type: "browser.host.result",
        id: request.id,
        result: {
          type: "screenshot",
          tabId: "tab_1",
          dataUrl: `data:image/png;base64,${Buffer.from("ok").toString("base64")}`,
          width: 10,
          height: 20,
        },
      })

      await expect(screenshotPromise).resolves.toEqual({ buffer: Buffer.from("ok"), width: 10, height: 20 })

      const cdp = await tab.ensureCDP()
      const cdpPromise = cdp.send("Runtime.evaluate", { expression: "1 + 1" })
      const cdpRequest = host.messages.find(
        (message) => message.type === "browser.host.command" && (message.command as { type?: string }).type === "cdp",
      )!
      expect(cdpRequest).toMatchObject({
        command: {
          type: "cdp",
          tabId: "tab_1",
          method: "Runtime.evaluate",
          params: { expression: "1 + 1" },
        },
      })
      connection.handleMessage({
        type: "browser.host.result",
        id: cdpRequest.id,
        result: {
          type: "cdp",
          tabId: "tab_1",
          value: { result: { value: 2 } },
        },
      })

      await expect(cdpPromise).resolves.toEqual({ result: { value: 2 } })
    } finally {
      restore()
    }
  })
})
