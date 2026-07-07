import { describe, expect, test } from "bun:test"
import { BrowserScreenshot } from "../../src/browser/screenshot"
import { BrowserScreenshotTool } from "../../src/tool/browser-screenshot"

describe("browser_screenshot production schema", () => {
  test("accepts locator in parsed data", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      format: "png",
      locator: { kind: "ref", value: "@e1" },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toHaveProperty("locator")
  })

  test("accepts clip in parsed data", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      format: "png",
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toHaveProperty("clip")
  })

  test("defaults save to false", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.save).toBe(false)
  })

  test("accepts save flag", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({ save: true })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.save).toBe(true)
  })

  test("rejects invalid clip values", async () => {
    const info = await BrowserScreenshotTool.init()
    expect(info.parameters.safeParse({ clip: { x: 0, y: 0, width: -1, height: 100 } }).success).toBe(false)
    expect(info.parameters.safeParse({ clip: { x: 0, y: 0, width: 100, height: 0 } }).success).toBe(false)
    expect(info.parameters.safeParse({ clip: { x: -1, y: 0, width: 100, height: 100 } }).success).toBe(false)
    expect(info.parameters.safeParse({ clip: { x: 0, y: -1, width: 100, height: 100 } }).success).toBe(false)
  })
})

describe("BrowserScreenshot clip helpers", () => {
  test("uses explicit clip directly", () => {
    const result = BrowserScreenshot.buildScreenshotParams({ clip: { x: 10, y: 20, width: 300, height: 200 } })
    expect(result).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  test("uses locator bounds when no explicit clip is provided", () => {
    const bounds = { x: 50, y: 60, width: 400, height: 300 }
    const result = BrowserScreenshot.buildScreenshotParams({ locator: { kind: "ref", value: "@e1" } }, bounds)
    expect(result).toEqual({ x: 50, y: 60, width: 400, height: 300 })
  })

  test("clip takes precedence over locator", () => {
    const bounds = { x: 50, y: 60, width: 400, height: 300 }
    const result = BrowserScreenshot.buildScreenshotParams(
      { locator: { kind: "ref", value: "@e1" }, clip: { x: 10, y: 20, width: 200, height: 100 } },
      bounds,
    )
    expect(result).toEqual({ x: 10, y: 20, width: 200, height: 100 })
  })

  test("resolved locator bounds are rounded and clamped", () => {
    const rounded = BrowserScreenshot.computeClipForLocator(
      { x: 50.7, y: 60.2, width: 400.9, height: 300.1 },
      { kind: "ref", value: "@e1" },
    )
    expect(rounded).toEqual({ x: 51, y: 60, width: 401, height: 300 })

    const clamped = BrowserScreenshot.computeClipForLocator(
      { x: -5, y: -10, width: 400, height: 300 },
      { kind: "ref", value: "@e1" },
    )
    expect(clamped).toEqual({ x: 0, y: 0, width: 400, height: 300 })
  })
})
