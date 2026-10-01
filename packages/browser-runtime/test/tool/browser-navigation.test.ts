import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser-core"
import { BrowserNavigationTool } from "@ericsanchezok/synergy-browser-runtime/tools/browser-navigation"
import { BrowserToolHelper } from "@ericsanchezok/synergy-browser-runtime/tools/browser-shared"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const originalWithTask = BrowserToolHelper.withTask
const originalResolveOwner = BrowserToolHelper.resolveOwner
const originalResolvePage = BrowserToolHelper.resolvePage
const originalExecute = BrowserToolHelper.execute
const originalWithActivity = BrowserToolHelper.withActivity
const originalGetOrCreateSession = BrowserToolHelper.getOrCreateSession

beforeEach(() =>
  runtime.run(() => {
    BrowserToolHelper.withTask = async (_ctx, fn) => fn()
    BrowserToolHelper.resolveOwner = async () => ({
      mode: "scope",
      scopeID: "scope-test",
      directory: null,
      workspaceID: null,
    })
    BrowserToolHelper.resolvePage = async () =>
      ({ id: "page-test", url: "https://example.com/", title: "Example", loading: false }) as never
    BrowserToolHelper.getOrCreateSession = async () =>
      ({
        status: "active",
        page: { id: "page-test", url: "https://example.com/", title: "Example", loading: false, lastActiveAt: null },
      }) as never
    BrowserToolHelper.withActivity = async (_ctx, _page, _kind, _tool, _label, fn) => fn()
  }),
)

afterEach(() =>
  runtime.run(() => {
    BrowserToolHelper.withTask = originalWithTask
    BrowserToolHelper.resolveOwner = originalResolveOwner
    BrowserToolHelper.resolvePage = originalResolvePage
    BrowserToolHelper.execute = originalExecute
    BrowserToolHelper.withActivity = originalWithActivity
    BrowserToolHelper.getOrCreateSession = originalGetOrCreateSession
  }),
)

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
  test("goto passes settle options and reports settle outcome with snapshot", () =>
    runtime.run(async () => {
      let received: Record<string, unknown> | undefined
      const targetPage = {
        id: "page-test",
        url: "https://example.com/target",
        title: "Target",
        isLoading: false,
        lastActiveAt: null,
      }
      BrowserToolHelper.execute = async (_ctx, _pageId, command) => {
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
            {
              pageId: "page-test",
              action: "goto",
              url: "https://example.com/target",
              settleMode: "networkquiet",
              settleTimeoutMs: 15_000,
            },
            context(),
          )

          expect(received).toMatchObject({
            type: "navigate",
            url: "https://example.com/target",
            source: "agent",
            settleMode: "networkquiet",
            settleTimeoutMs: 15_000,
          })
          expect(JSON.parse(result.output)).toMatchObject({
            settled: true,
            settleReason: "networkquiet",
            settleElapsedMs: 1200,
            snapshot: { snapshotId: "snap-nav", elements: [{ ref: "@1-1" }] },
            page: { url: "https://example.com/target" },
          })
          expect(result.metadata.url).toBe("https://example.com/target")
        },
      })
    }))

  test("unsettled navigation reports settled:false as a settle outcome, not a failure", () =>
    runtime.run(async () => {
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
          const result = await tool.execute(
            { pageId: "page-test", action: "goto", url: "https://example.com/" },
            context(),
          )

          expect(JSON.parse(result.output)).toMatchObject({
            settled: false,
            settleReason: "timeout",
            settleElapsedMs: 30_000,
            inflightRequests: 1,
          })
          expect(JSON.parse(result.output).settled).toBe(false)
        },
      })
    }))

  test("reports that an explicitly disabled snapshot was not requested", () =>
    runtime.run(async () => {
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
            { pageId: "page-test", action: "goto", url: "https://example.com/", includeSnapshot: false },
            context(),
          )

          expect(JSON.parse(result.output).snapshot).toBeUndefined()
        },
      })
    }))

  test("current surfaces the last stored error and its suggested action without creating a page", () =>
    runtime.run(async () => {
      BrowserToolHelper.getOrCreateSession = async () =>
        ({
          status: "failed",
          pages: [
            {
              id: "page-test",
              url: "https://example.com/",
              title: "Example",
              lastActiveAt: null,
              profileId: "personal",
              status: "failed",
              error: {
                type: "error",
                code: "browser_session_failed",
                message: "Recovery failed.",
                retryable: false,
                suggestedAction: "Use browser_navigation with action resume.",
              },
            },
          ],
        }) as never
      await ScopeContext.provide({
        scope: { id: "scope-test", name: "test", directory: "/tmp" } as never,
        fn: async () => {
          const tool = await BrowserNavigationTool.init()
          const result = await tool.execute({ pageId: "page-test", action: "current" }, context())

          expect(JSON.parse(result.output)).toMatchObject({
            status: "failed",
            error: {
              code: "browser_session_failed",
              message: "Recovery failed.",
              suggestedAction: "Use browser_navigation with action resume.",
            },
          })
        },
      })
    }))

  test("guides unknown navigation outcomes to verification instead of blind retries", () =>
    runtime.run(async () => {
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
          const received = await tool.execute({ pageId: "page-test", action: "reload" }, context()).then(
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
    }))
})

afterRuntimeTests(() => runtime.close())
