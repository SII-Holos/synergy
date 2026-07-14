import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserScreenshotTool } from "../../src/tool/browser-screenshot"
import { BrowserToolHelper } from "../../src/tool/browser-shared"

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

const originalResolvePage = BrowserToolHelper.resolvePage
const originalExecute = BrowserToolHelper.execute
const originalWithActivity = BrowserToolHelper.withActivity

beforeEach(() => {
  BrowserToolHelper.resolvePage = async () =>
    ({ id: "page-test", url: "https://example.com/", title: "Example" }) as never
  BrowserToolHelper.execute = async () =>
    ({
      type: "screenshot",
      pageId: "page-test",
      dataUrl: PNG_DATA_URL,
      width: 1,
      height: 1,
    }) as never
  BrowserToolHelper.withActivity = async (_ctx, _page, _kind, _tool, _label, fn) => fn()
})

afterEach(() => {
  BrowserToolHelper.resolvePage = originalResolvePage
  BrowserToolHelper.execute = originalExecute
  BrowserToolHelper.withActivity = originalWithActivity
})

function context(supportsImageInput: boolean, lookAtAvailable = true) {
  return {
    sessionID: "ses_browser_screenshot_test",
    messageID: "msg_browser_screenshot_test",
    callID: "call_browser_screenshot_test",
    agent: "synergy-max",
    abort: new AbortController().signal,
    extra: {
      model: {
        capabilities: { input: { image: supportsImageInput } },
      },
      lookAtAvailable,
    },
    metadata() {},
    async ask() {},
  }
}

describe("tool.browser_screenshot", () => {
  test("gives image-capable models the screenshot in model context", async () => {
    const tool = await BrowserScreenshotTool.init()
    const result = await tool.execute({}, context(true))

    expect(result.output).toContain("current model context")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      mime: "image/png",
      url: PNG_DATA_URL,
      model: { mode: "provider-file" },
    })
  })

  test("gives text-only models a real local path and mentions look_at when available", async () => {
    const tool = await BrowserScreenshotTool.init()
    const result = await tool.execute({}, context(false, true))

    const attachment = result.attachments?.[0]
    expect(attachment?.localPath).toBeTruthy()
    expect(await Bun.file(attachment!.localPath!).exists()).toBe(true)
    expect(attachment?.url).toStartWith("asset://")
    expect(attachment?.model).toMatchObject({ mode: "summary" })
    expect(result.output).toContain("look_at")
    expect(result.output).toContain(attachment!.localPath!)
  })

  test("text-only model with lookAtAvailable:false returns a local asset path but does not mention look_at", async () => {
    const tool = await BrowserScreenshotTool.init()
    const result = await tool.execute({}, context(false, false))

    const attachment = result.attachments?.[0]
    expect(attachment?.localPath).toBeTruthy()
    expect(await Bun.file(attachment!.localPath!).exists()).toBe(true)
    expect(attachment?.url).toStartWith("asset://")
    expect(attachment?.model).toMatchObject({ mode: "summary" })
    // Must produce a real path but must not claim look_at is available.
    expect(result.output).not.toContain("look_at")
    expect(result.output).toContain(attachment!.localPath!)
    expect(result.metadata.modelDelivery).toBe("local_only")
  })
})
