import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserNavigationTool } from "../../src/tool/browser-navigation"
import { BrowserToolHelper } from "../../src/tool/browser-shared"
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

  test("unsettled navigation reports settled:false as a settle outcome, not a failure", async () => {
    BrowserToolHelper.execute = async () => ({
      type: "navigation",
      page: { id: "page-test", url: "https://example.com/", title: "Example", isLoading: true, lastActiveAt: null },
      settled: false,
      settleReason: "timeout",
      settleElapsedMs: 30_000,
      inflightRequests: 1,
    })
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const result = await tool.execute({ action: "goto", url: "https://example.com/" }, context())

        expect(result.output).toContain("Settled: no (timeout) after 30000ms; 1 request(s) still in flight")
        expect(result.output).toContain("settled:false is a settle outcome, not an action failure")
        expect(result.output).toContain("Snapshot: unavailable")
        expect(result.metadata.settled).toBe(false)
      },
    })
  })

  test("reports that an explicitly disabled snapshot was not requested", async () => {
    BrowserToolHelper.execute = async () => ({
      type: "navigation",
      page: { id: "page-test", url: "https://example.com/", title: "Example", isLoading: false, lastActiveAt: null },
      settled: true,
      settleReason: "load",
      settleElapsedMs: 100,
    })
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const result = await tool.execute(
          { action: "goto", url: "https://example.com/", includeSnapshot: false },
          context(),
        )

        expect(result.output).toContain("Snapshot: not requested")
        expect(result.output).not.toContain("Snapshot: unavailable")
      },
    })
  })

  test("current surfaces the last stored error and its suggested action without creating a page", async () => {
    BrowserToolHelper.getOrCreateSession = async () =>
      ({
        status: "failed",
        page: null,
        descriptor: { id: "page-test", url: "https://example.com/", title: "Example", lastActiveAt: null },
        error: {
          type: "error",
          code: "browser_session_failed",
          message: "Recovery failed.",
          retryable: false,
          suggestedAction: "Use browser_navigation with action resume.",
        },
      }) as never
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const result = await tool.execute({ action: "current" }, context())

        expect(result.output).toContain("Status: failed")
        expect(result.output).toContain("Last error: browser_session_failed — Recovery failed.")
        expect(result.output).toContain("Suggested next step: Use browser_navigation with action resume.")
        expect(result.metadata).toMatchObject({
          status: "failed",
          lastError: { code: "browser_session_failed" },
        })
      },
    })
  })

  test("guides unknown navigation outcomes to verification instead of blind retries", async () => {
    BrowserToolHelper.execute = async () => {
      throw new BrowserProtocolError({
        code: "browser_command_aborted",
        message: "Browser command was cancelled.",
        retryable: true,
        commandId: "call-1:navigate",
        pageId: "page-test",
      })
    }
    await ScopeContext.provide({
      scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
      fn: async () => {
        const tool = await BrowserNavigationTool.init()
        const received = await tool.execute({ action: "reload" }, context()).then(
          () => undefined,
          (error) => error,
        )

        expect(received).toBeInstanceOf(BrowserProtocolError)
        const error = received as BrowserProtocolError
        expect(error.code).toBe("browser_command_aborted")
        expect(error.suggestedAction).toContain("outcome of browser_navigation reload is unknown")
        expect(error.suggestedAction).toContain("Do NOT re-execute it")
        expect(error.suggestedAction).toContain("browser_snapshot")
      },
    })
  })
})
