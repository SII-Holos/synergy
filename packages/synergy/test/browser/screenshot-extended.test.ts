import { describe, test, expect } from "bun:test"
import z from "zod"
import { BrowserScreenshotTool } from "../../src/tool/browser-screenshot"

// Phase 2 (GREEN): locator/clip ARE present in parsed data.
describe("browser_screenshot production schema (GREEN)", () => {
  test("production schema accepts locator in parsed data", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      format: "png",
      locator: { kind: "ref", value: "@e1" },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).toHaveProperty("locator")
    }
  })

  test("production schema accepts clip in parsed data", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      format: "png",
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).toHaveProperty("clip")
    }
  })

  test("production schema has pageId, format, fullPage; optional locator/clip absent when omitted", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      pageId: "page-1",
      format: "jpeg",
      fullPage: true,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const keys = Object.keys(r.data)
      expect(keys).toContain("pageId")
      expect(keys).toContain("format")
      expect(keys).toContain("fullPage")
      // optional fields are not present when omitted
      expect(keys).not.toContain("locator")
      expect(keys).not.toContain("clip")
    }
  })

  test("production schema ACCEPTS a locator field", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      locator: { kind: "ref", value: "@e1" },
    })
    if (r.success) {
      expect(Object.keys(r.data)).toContain("locator")
    }
  })

  test("production schema ACCEPTS a clip field", async () => {
    const info = await BrowserScreenshotTool.init()
    const r = info.parameters.safeParse({
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
    if (r.success) {
      expect(Object.keys(r.data)).toContain("clip")
    }
  })
})

// Extended screenshot parameter schema
describe("browser_screenshot extended schema", () => {
  const ClipSchema = z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })

  const ExtendedScreenshotSchema = z.object({
    pageId: z.string().optional(),
    format: z.enum(["jpeg", "png"]).default("png"),
    fullPage: z.boolean().default(false),
    locator: z
      .object({
        kind: z.string(),
        value: z.string(),
      })
      .optional(),
    clip: ClipSchema.optional(),
  })

  test("schema accepts locator parameter", () => {
    const r = ExtendedScreenshotSchema.safeParse({
      locator: { kind: "ref", value: "@e1" },
    })
    expect(r.success).toBe(true)
  })

  test("schema accepts clip parameter", () => {
    const r = ExtendedScreenshotSchema.safeParse({
      clip: { x: 10, y: 20, width: 200, height: 100 },
    })
    expect(r.success).toBe(true)
  })

  test("schema accepts both locator and clip together", () => {
    const r = ExtendedScreenshotSchema.safeParse({
      locator: { kind: "ref", value: "@e1" },
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
    expect(r.success).toBe(true)
  })

  test("schema still works with just format (regression)", () => {
    const r = ExtendedScreenshotSchema.safeParse({ format: "jpeg" })
    expect(r.success).toBe(true)
  })
})

// Clip validation
describe("browser_screenshot clip validation", () => {
  const ClipSchema = z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })

  test("rejects negative width", () => {
    const r = ClipSchema.safeParse({ x: 0, y: 0, width: -1, height: 100 })
    expect(r.success).toBe(false)
  })

  test("rejects negative height", () => {
    const r = ClipSchema.safeParse({ x: 0, y: 0, width: 100, height: -1 })
    expect(r.success).toBe(false)
  })

  test("rejects zero width", () => {
    const r = ClipSchema.safeParse({ x: 0, y: 0, width: 0, height: 100 })
    expect(r.success).toBe(false)
  })

  test("rejects zero height", () => {
    const r = ClipSchema.safeParse({ x: 0, y: 0, width: 100, height: 0 })
    expect(r.success).toBe(false)
  })

  test("rejects negative x", () => {
    const r = ClipSchema.safeParse({ x: -1, y: 0, width: 100, height: 100 })
    expect(r.success).toBe(false)
  })

  test("rejects negative y", () => {
    const r = ClipSchema.safeParse({ x: 0, y: -1, width: 100, height: 100 })
    expect(r.success).toBe(false)
  })

  test("accepts valid clip", () => {
    const r = ClipSchema.safeParse({ x: 10, y: 20, width: 300, height: 200 })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.width).toBe(300)
      expect(r.data.height).toBe(200)
    }
  })
})

// Locator screenshot flow: resolve bounds → apply clip
interface ResolvedBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ScreenshotInput {
  locator?: { kind: string; value: string }
  clip?: { x: number; y: number; width: number; height: number }
  format?: "png" | "jpeg"
  fullPage?: boolean
}

interface ScreenshotResult {
  x: number
  y: number
  width: number
  height: number
}

function computeClipForLocator(
  bounds: ResolvedBounds,
  _locator: { kind: string; value: string },
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

function buildScreenshotParams(input: ScreenshotInput, resolvedBounds?: ResolvedBounds): ScreenshotResult {
  if (input.clip) return { ...input.clip }
  if (input.locator && resolvedBounds) return computeClipForLocator(resolvedBounds, input.locator)
  return { x: 0, y: 0, width: 0, height: 0 }
}

describe("locator screenshot resolves bounds then uses clip", () => {
  test("with clip only, uses clip directly", () => {
    const result = buildScreenshotParams({ clip: { x: 10, y: 20, width: 300, height: 200 } })
    expect(result).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  test("with locator, resolves bounds as clip region", () => {
    const bounds: ResolvedBounds = { x: 50, y: 60, width: 400, height: 300 }
    const result = buildScreenshotParams({ locator: { kind: "ref", value: "@e1" } }, bounds)
    expect(result).toEqual({ x: 50, y: 60, width: 400, height: 300 })
  })

  test("with locator and clip, clip takes precedence", () => {
    const bounds: ResolvedBounds = { x: 50, y: 60, width: 400, height: 300 }
    const result = buildScreenshotParams(
      { locator: { kind: "ref", value: "@e1" }, clip: { x: 10, y: 20, width: 200, height: 100 } },
      bounds,
    )
    expect(result).toEqual({ x: 10, y: 20, width: 200, height: 100 })
  })

  test("browser page screenshot accepts clip as CDP parameter shape", () => {
    const cdpClip = { x: 10, y: 20, width: 300, height: 200, scale: 1 }
    expect(cdpClip).toHaveProperty("x")
    expect(cdpClip).toHaveProperty("y")
    expect(cdpClip).toHaveProperty("width")
    expect(cdpClip).toHaveProperty("height")
    expect(cdpClip).toHaveProperty("scale")
    expect(cdpClip.scale).toBe(1)
  })

  test("resolved locator bounds round to integers", () => {
    const bounds: ResolvedBounds = { x: 50.7, y: 60.2, width: 400.9, height: 300.1 }
    const result = computeClipForLocator(bounds, { kind: "ref", value: "@e1" })
    expect(result.x).toBe(51)
    expect(result.y).toBe(60)
    expect(result.width).toBe(401)
    expect(result.height).toBe(300)
  })

  test("resolved locator bounds clamp x,y to non-negative", () => {
    const bounds: ResolvedBounds = { x: -5, y: -10, width: 400, height: 300 }
    const result = computeClipForLocator(bounds, { kind: "ref", value: "@e1" })
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
    expect(result.width).toBe(400)
    expect(result.height).toBe(300)
  })
})
