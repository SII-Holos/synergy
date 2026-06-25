import { afterEach, describe, expect, test } from "bun:test"
import { BrowserHostControl, type BrowserHostControlSocket } from "../../src/browser/host-control"
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
    expect(events).toEqual([{ type: "page.loaded", tabId: "tab_1", url: "https://example.com/" }])
  })
})
