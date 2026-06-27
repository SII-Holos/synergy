import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHost } from "../../src/browser/host"
import {
  BrowserHostControl,
  BrowserHostControlNotAttachedError,
  type BrowserHostControlSocket,
} from "../../src/browser/host-control"
import type { BrowserOwner } from "../../src/browser/owner"
import { BrowserToolHelper } from "../../src/tool/browser-shared"

const owner: BrowserOwner.Info = {
  directory: "/tmp/synergy",
  scopeID: "scope",
  sessionID: "ses_host",
  mode: "session",
}

function page(id: string, url = "https://example.com/") {
  return {
    id,
    url,
    title: "Example",
    isLoading: false,
    lastActiveAt: null,
  }
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

  test("records host page state and resolves command results", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer, { pageId: "page_1" })
    connection.handleMessage({
      type: "browser.host.ready",
      session: { page: page("page_1") },
    })

    expect(BrowserHostControl.sessionState(owner)?.page?.id).toBe("page_1")

    const resultPromise = BrowserHostControl.execute(owner, {
      type: "navigate",
      pageId: "page_1",
      url: "https://example.com/docs",
    })
    const request = host.messages.find((message) => message.type === "browser.host.command")!

    expect(request).toMatchObject({
      type: "browser.host.command",
      command: { type: "navigate", pageId: "page_1", url: "https://example.com/docs" },
    })

    connection.handleMessage({
      type: "browser.host.result",
      id: request.id,
      result: {
        type: "navigation",
        url: "https://example.com/docs",
        title: "Docs",
        page: {
          ...page("page_1", "https://example.com/docs"),
          title: "Docs",
        },
      },
    })

    await expect(resultPromise).resolves.toMatchObject({ type: "navigation", title: "Docs" })
  })

  test("forwards host page events to owner observers", () => {
    const host = socket()
    const events: Record<string, unknown>[] = []
    const unsubscribe = BrowserHostControl.addObserver(owner, (event) => events.push(event))
    const connection = BrowserHostControl.attach(owner, host.peer, { pageId: "page_1" })

    connection.handleMessage({
      type: "browser.host.event",
      event: { type: "page.loaded", pageId: "page_1", url: "https://example.com/" },
    })

    unsubscribe()
    expect(events).toContainEqual({ type: "page.loaded", pageId: "page_1", url: "https://example.com/" })
  })

  test("tracks host readiness and resolves ready waiters", async () => {
    const host = socket()
    const ready = BrowserHostControl.waitForReady(owner, "page_1", 1_000)
    const connection = BrowserHostControl.attach(owner, host.peer, { pageId: "page_1", traceId: "trace_1" })

    expect(BrowserHostControl.status(owner, "page_1")).toBe("pending")
    expect(BrowserHostControl.isReady(owner, "page_1")).toBe(false)

    connection.handleMessage({
      type: "browser.host.ready",
      session: { page: page("page_1") },
    })

    await expect(ready).resolves.toBe(connection)
    expect(BrowserHostControl.status(owner, "page_1")).toBe("ready")
    expect(BrowserHostControl.isReady(owner, "page_1")).toBe(true)
  })

  test("throws a typed error when no host can handle a command", async () => {
    await expect(BrowserHostControl.execute(owner, { type: "reload", pageId: "missing" })).rejects.toBeInstanceOf(
      BrowserHostControlNotAttachedError,
    )
  })

  test("routes commands to the exact per-page Browser Host connection", async () => {
    const host1 = socket()
    const host2 = socket()
    const connection1 = BrowserHostControl.attach(owner, host1.peer, { pageId: "page_1" })
    const connection2 = BrowserHostControl.attach(owner, host2.peer, { pageId: "page_2" })

    connection1.handleMessage({ type: "browser.host.ready", session: { page: page("page_1") } })
    connection2.handleMessage({ type: "browser.host.ready", session: { page: page("page_2", "https://example.org/") } })

    const navigatePromise = BrowserHostControl.execute(owner, {
      type: "navigate",
      pageId: "page_1",
      url: "https://example.com/docs",
    })
    const navigateRequest = host1.messages.find((message) => message.type === "browser.host.command")!
    expect(navigateRequest).toMatchObject({ command: { type: "navigate", pageId: "page_1" } })
    expect(host2.messages.find((message) => message.type === "browser.host.command")).toBeUndefined()

    connection1.handleMessage({
      type: "browser.host.result",
      id: navigateRequest.id,
      result: {
        type: "navigation",
        url: "https://example.com/docs",
        title: "Docs",
        page: {
          ...page("page_1", "https://example.com/docs"),
          title: "Docs",
        },
      },
    })
    await expect(navigatePromise).resolves.toMatchObject({ type: "navigation", page: { id: "page_1" } })
  })

  test("BrowserHost normalizes address-bar URLs before sending commands to an attached host", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer, { pageId: "page_1" })
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
        pageId: "page_1",
        url: "www.google.com",
        source: "user",
      })
      const request = host.messages.find((message) => message.type === "browser.host.command")!

      expect(request).toMatchObject({
        type: "browser.host.command",
        command: { type: "navigate", pageId: "page_1", url: "https://www.google.com" },
      })

      connection.handleMessage({
        type: "browser.host.result",
        id: request.id,
        result: {
          type: "navigation",
          url: "https://www.google.com/",
          title: "Google",
          page: {
            ...page("page_1", "https://www.google.com/"),
            title: "Google",
          },
        },
      })

      await expect(resultPromise).resolves.toMatchObject({ type: "navigation", title: "Google" })
    } finally {
      restore()
    }
  })

  test("tool helpers resolve attached Browser Host pages before runtime", async () => {
    const host = socket()
    const connection = BrowserHostControl.attach(owner, host.peer, { pageId: "page_1" })
    connection.handleMessage({
      type: "browser.host.ready",
      session: { page: page("page_1") },
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
      const resolved = await BrowserToolHelper.getPage(owner)
      expect(resolved.id).toBe("page_1")
      expect(resolved.page).toBeUndefined()

      const screenshotPromise = resolved.screenshot("png")
      const request = host.messages.find(
        (message) =>
          message.type === "browser.host.command" && (message.command as { type?: string }).type === "screenshot",
      )!
      expect(request).toMatchObject({
        command: { type: "screenshot", pageId: "page_1", format: "png" },
      })
      connection.handleMessage({
        type: "browser.host.result",
        id: request.id,
        result: {
          type: "screenshot",
          pageId: "page_1",
          dataUrl: `data:image/png;base64,${Buffer.from("ok").toString("base64")}`,
          width: 10,
          height: 20,
        },
      })

      await expect(screenshotPromise).resolves.toEqual({ buffer: Buffer.from("ok"), width: 10, height: 20 })
    } finally {
      restore()
    }
  })
})
