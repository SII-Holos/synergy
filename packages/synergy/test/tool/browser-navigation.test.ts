import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserNavigationTool } from "../../src/browser/tools/browser-navigation"
import { BrowserToolHelper } from "../../src/browser/tools/browser-shared"
import { ScopeContext } from "../../src/scope/context"

const originalResolvePage = BrowserToolHelper.resolvePage
const originalExecute = BrowserToolHelper.execute
const originalWithActivity = BrowserToolHelper.withActivity
const originalGetOrCreateSession = BrowserToolHelper.getOrCreateSession

beforeEach(() => {
  BrowserToolHelper.resolvePage = async () =>
    ({ id: "page-test", url: "https://example.com/", title: "Example", loading: false }) as never
  BrowserToolHelper.getOrCreateSession = async () =>
    ({
      status: "active",
      page: { id: "page-test", url: "https://example.com/", title: "Example", loading: false, lastActiveAt: null },
    }) as never
  BrowserToolHelper.withActivity = async (_ctx, _page, _kind, _tool, _label, fn) => fn()
})

afterEach(() => {
  BrowserToolHelper.resolvePage = originalResolvePage
  BrowserToolHelper.execute = originalExecute
  BrowserToolHelper.withActivity = originalWithActivity
  BrowserToolHelper.getOrCreateSession = originalGetOrCreateSession
})

function context() {
  return {
    sessionID: "ses_browser_navigation_test",
    messageID: "msg_browser_navigation_test",
    callID: "call_browser_navigation_test",
    agent: "synergy-max",
    abort: new AbortController().signal,
    extra: {},
    metadata() {},
    async ask() {},
  }
}

describe("tool.browser_navigation", () => {
  test("goto passes settle options and reports settle outcome with snapshot", async () => {
    let received: Record<string, unknown> | undefined
    const targetPage = {
      id: "page-test",
      url: "https://example.com/target",
      title: "Target",
      isLoading: false,
      lastActiveAt: null,
    }
    BrowserToolHelper.execute = async (_ctx, command) => {
      received = command as Record<string, unknown>
      return {
        type: "navigation",
        page: targetPage,
        settled: true,
        settleReason: "networkquiet",
        settleElapsedMs: 1200,
        snapshot: {
          type: "snapshot",
          pageId: "page-test",
          snapshotId: "snap-nav",
          elements: [{ ref: "@1-1", role: "heading", name: "Target", depth: 0 }],
          truncated: false,
        },
      }
    }
    BrowserToolHelper.getOrCreateSession = async () => ({ status: "active", page: targetPage }) as never
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const result = await tool.execute(
          { action: "goto", url: "https://example.com/target", settleMode: "networkquiet", settleTimeoutMs: 15_000 },
          context(),
        )

        expect(received).toMatchObject({
          type: "navigate",
          url: "https://example.com/target",
          source: "agent",
          settleMode: "networkquiet",
          settleTimeoutMs: 15_000,
        })
        expect(result.output).toContain("Settled: yes (networkquiet)")
        expect(result.output).toContain("Snapshot: snap-nav (1 elements)")
        expect(result.metadata).toMatchObject({
          action: "goto",
          settled: true,
          settleReason: "networkquiet",
          settleElapsedMs: 1200,
          elementsCount: 1,
          snapshotId: "snap-nav",
          url: "https://example.com/target",
        })
      },
    })
  })

  test("unsettled navigation reports settled:false without failing", async () => {
    BrowserToolHelper.execute = async () => ({
      type: "navigation",
      page: { id: "page-test", url: "https://example.com/", title: "Example", isLoading: true, lastActiveAt: null },
      settled: false,
      settleReason: "timeout",
      settleElapsedMs: 30_000,
    })
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const result = await tool.execute({ action: "goto", url: "https://example.com/" }, context())

        expect(result.output).toContain("Settled: no (timeout)")
        expect(result.metadata.settled).toBe(false)
      },
    })
  })
})
