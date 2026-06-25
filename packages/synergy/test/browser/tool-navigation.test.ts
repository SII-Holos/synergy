import { describe, expect, test } from "bun:test"
import { BrowserToolHelper, BrowserTabNotFoundError } from "../../src/tool/browser-shared"
import { BlockedURLNavigationError, type BrowserTab } from "../../src/browser/tab"
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
