import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserProtocolError } from "@ericsanchezok/synergy-browser"
import { BrowserActionTool } from "../../src/browser/tools/browser-action"
import { BrowserToolHelper } from "../../src/browser/tools/browser-shared"

const originalResolvePage = BrowserToolHelper.resolvePage
const originalExecute = BrowserToolHelper.execute
const originalWithActivity = BrowserToolHelper.withActivity

const snapshot = {
  type: "snapshot",
  pageId: "page-test",
  snapshotId: "snap-1",
  elements: [
    { ref: "@1-1", role: "button", name: "Save", depth: 1 },
    { ref: "@1-2", role: "textbox", name: "Name", value: "Ada", depth: 1 },
  ],
  truncated: false,
}

beforeEach(() => {
  BrowserToolHelper.resolvePage = async () =>
    ({ id: "page-test", url: "https://example.com/", title: "Example", loading: false }) as never
  BrowserToolHelper.execute = async () =>
    ({
      type: "action",
      pageId: "page-test",
      action: "click",
      settled: true,
      settleReason: "networkquiet",
      settleElapsedMs: 842,
      snapshot,
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
    sessionID: "ses_browser_action_test",
    messageID: "msg_browser_action_test",
    callID: "call_browser_action_test",
    agent: "synergy-max",
    abort: new AbortController().signal,
    extra: {},
    metadata() {},
    async ask() {},
  }
}

describe("tool.browser_action", () => {
  test("reports dispatch, settle outcome, and a fresh snapshot in the result", async () => {
    const tool = await BrowserActionTool.init()
    const result = await tool.execute(
      {
        action: {
          type: "click",
          target: { kind: "role", role: "button", name: "Save" },
          settleMode: "networkquiet",
          settleTimeoutMs: 30_000,
        },
      },
      context(),
    )

    expect(result.output).toContain("Dispatched click on the target.")
    expect(result.output).toContain("Settled: yes (networkquiet) after 842ms")
    expect(result.output).toContain("snapshotId: snap-1")
    expect(result.metadata).toMatchObject({
      actionType: "click",
      target: { kind: "role", role: "button", name: "Save" },
      settled: true,
      settleReason: "networkquiet",
      settleElapsedMs: 842,
      elementsCount: 2,
      snapshotId: "snap-1",
      includeSnapshot: true,
      url: "https://example.com/",
      isLoading: false,
    })
  })

  test("exposes only the value length for fill and type actions", async () => {
    const tool = await BrowserActionTool.init()
    const result = await tool.execute(
      {
        action: {
          type: "fill",
          target: { kind: "label", text: "Name" },
          value: "Ada Lovelace",
        },
      },
      context(),
    )

    expect(result.metadata.valueLength).toBe(12)
    expect(JSON.stringify(result.metadata)).not.toContain("Ada Lovelace")
  })

  test("marks non-settled results as a settle outcome, not an action failure", async () => {
    BrowserToolHelper.execute = async () =>
      ({
        type: "action",
        pageId: "page-test",
        action: "click",
        settled: false,
        settleReason: "timeout",
        settleElapsedMs: 30_000,
        inflightRequests: 2,
      }) as never
    const tool = await BrowserActionTool.init()
    const result = await tool.execute(
      {
        action: {
          type: "click",
          target: { kind: "role", role: "button", name: "Save" },
        },
      },
      context(),
    )

    expect(result.output).toContain("Settled: no (timeout) after 30000ms; 2 request(s) still in flight")
    expect(result.output).toContain("settled:false is a settle outcome, not an action failure")
    expect(result.output).toContain("do not retry the action blindly")
    expect(result.metadata.settled).toBe(false)
    expect(result.metadata.settleReason).toBe("timeout")
    expect(result.metadata.inflightRequests).toBe(2)
  })

  test("states only dispatch evidence and never claims business completion", async () => {
    const tool = await BrowserActionTool.init()
    const result = await tool.execute(
      {
        action: {
          type: "click",
          target: { kind: "role", role: "button", name: "Save" },
        },
      },
      context(),
    )

    expect(result.output).toContain("business effects (saved, sent, applied) are NOT verified")
    expect(result.output).toContain("before claiming completion")
    expect(result.output).not.toMatch(/Saved\.|Sent\.|Applied\.|saved successfully/)
  })

  test("warns that a skipped settle weakens snapshot evidence", async () => {
    BrowserToolHelper.execute = async () =>
      ({
        type: "action",
        pageId: "page-test",
        action: "click",
        settled: true,
        settleReason: "none",
        settleElapsedMs: 0,
        snapshot,
      }) as never
    const tool = await BrowserActionTool.init()
    const result = await tool.execute(
      {
        action: {
          type: "click",
          target: { kind: "role", role: "button", name: "Save" },
          settleMode: "none",
        },
      },
      context(),
    )

    expect(result.output).toContain("Settle was skipped, so the snapshot is NOT post-settle evidence.")
  })

  test("guides unknown outcomes to verification instead of blind side-effect retries", async () => {
    BrowserToolHelper.execute = async () => {
      throw new BrowserProtocolError({
        code: "browser_host_timeout",
        message: "Browser Host request timed out: page.command",
        retryable: true,
        commandId: "call-1:action",
        pageId: "page-test",
      })
    }
    const tool = await BrowserActionTool.init()
    const received = await tool
      .execute(
        {
          action: {
            type: "click",
            target: { kind: "role", role: "button", name: "Send" },
          },
        },
        context(),
      )
      .then(
        () => undefined,
        (error) => error,
      )

    expect(received).toBeInstanceOf(BrowserProtocolError)
    const error = received as BrowserProtocolError
    expect(error.code).toBe("browser_host_timeout")
    expect(error.commandId).toBe("call-1:action")
    expect(error.message).toContain("outcome of browser_action click is unknown")
    expect(error.message).toContain("Do NOT re-execute it")
    expect(error.suggestedAction).toContain("browser_navigation current")
    expect(error.suggestedAction).toContain("a fresh call")
  })
})
