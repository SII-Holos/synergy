import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserWaitTool } from "../../src/browser/tools/browser-wait"
import { BrowserToolHelper } from "../../src/browser/tools/browser-shared"

const originalResolvePage = BrowserToolHelper.resolvePage
const originalExecute = BrowserToolHelper.execute
const originalWithActivity = BrowserToolHelper.withActivity

beforeEach(() => {
  BrowserToolHelper.resolvePage = async () =>
    ({ id: "page-test", url: "https://example.com/", title: "Example", loading: false }) as never
  BrowserToolHelper.execute = async () =>
    ({
      type: "wait",
      pageId: "page-test",
      matched: true,
      elapsedMs: 312,
      page: { id: "page-test", url: "https://example.com/", title: "Example", isLoading: false, lastActiveAt: null },
    }) as never
  BrowserToolHelper.withActivity = async (_ctx, _page, _kind, _tool, _label, fn) => fn()
})

afterEach(() => {
  BrowserToolHelper.resolvePage = originalResolvePage
  BrowserToolHelper.execute = originalExecute
  BrowserToolHelper.withActivity = originalWithActivity
})

function context() {
  return {
    sessionID: "ses_browser_wait_test",
    messageID: "msg_browser_wait_test",
    callID: "call_browser_wait_test",
    agent: "synergy-max",
    abort: new AbortController().signal,
    extra: {},
    metadata() {},
    async ask() {},
  }
}

describe("tool.browser_wait", () => {
  test("reports the satisfied condition with elapsed time and page state", async () => {
    const tool = await BrowserWaitTool.init()
    const result = await tool.execute(
      {
        condition: { type: "text", values: ["Ready"], match: "any" },
        timeoutMs: 10_000,
      },
      context(),
    )

    expect(result.output).toContain("Condition text was satisfied in 312ms")
    expect(result.metadata).toMatchObject({
      condition: { type: "text", values: ["Ready"], match: "any" },
      timeoutMs: 10_000,
      matched: true,
      elapsedMs: 312,
      url: "https://example.com/",
      title: "Example",
      isLoading: false,
    })
  })

  test("falls back to the configured timeout when elapsed time is absent", async () => {
    BrowserToolHelper.execute = async () => ({ type: "wait", pageId: "page-test", matched: true }) as never
    const tool = await BrowserWaitTool.init()
    const result = await tool.execute(
      {
        condition: { type: "load", state: "load" },
        timeoutMs: 10_000,
      },
      context(),
    )

    expect(result.output).toContain("Condition load was satisfied within 10000ms")
  })
})
