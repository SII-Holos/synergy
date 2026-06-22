import { describe, test, expect } from "bun:test"
import {
  BrowserViewport,
  createViewportConfig,
  validateViewportDimensions,
  validateDeviceScaleFactor,
  validateViewport,
  calculateClipBounds,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
  MIN_DSF,
  MAX_DSF,
  DEFAULT,
} from "../../src/browser/viewport"

describe("BrowserViewport", () => {
  // ── Viewport dimensions validation ─────────────────────────────

  test("validates viewport width min 320", () => {
    expect(validateViewportDimensions(MIN_WIDTH, MIN_HEIGHT).ok).toBe(true)
  })

  test("validates viewport width max 7680", () => {
    expect(validateViewportDimensions(MAX_WIDTH, MAX_HEIGHT).ok).toBe(true)
  })

  test("validates viewport height min 240", () => {
    expect(validateViewportDimensions(MIN_WIDTH, MIN_HEIGHT).ok).toBe(true)
  })

  test("validates viewport height max 4320", () => {
    expect(validateViewportDimensions(MAX_WIDTH, MAX_HEIGHT).ok).toBe(true)
  })

  test("rejects width below minimum", () => {
    const r = validateViewportDimensions(200, 720)
    expect(r.ok).toBe(false)
    expect(r.message).toContain("320")
  })

  test("rejects height above maximum", () => {
    const r = validateViewportDimensions(1280, 5000)
    expect(r.ok).toBe(false)
    expect(r.message).toContain("4320")
  })

  // ── Device scale factor validation ─────────────────────────────

  test("validates device scale factor min 0.25", () => {
    expect(validateDeviceScaleFactor(MIN_DSF).ok).toBe(true)
  })

  test("validates device scale factor max 4.0", () => {
    expect(validateDeviceScaleFactor(MAX_DSF).ok).toBe(true)
  })

  test("rejects negative scale factor", () => {
    const r = validateDeviceScaleFactor(-1)
    expect(r.ok).toBe(false)
  })

  test("rejects scale factor above maximum", () => {
    const r = validateDeviceScaleFactor(5)
    expect(r.ok).toBe(false)
  })

  // ── Viewport state ─────────────────────────────────────────────

  test("viewport state includes width/height/dsf/mobile", () => {
    const vp = createViewportConfig(1024, 768, 2, true)
    expect(vp.width).toBe(1024)
    expect(vp.height).toBe(768)
    expect(vp.deviceScaleFactor).toBe(2)
    expect(vp.mobile).toBe(true)
  })

  test("viewport state defaults", () => {
    const vp = createViewportConfig()
    expect(vp.width).toBe(DEFAULT.width)
    expect(vp.height).toBe(DEFAULT.height)
    expect(vp.deviceScaleFactor).toBe(DEFAULT.deviceScaleFactor)
    expect(vp.mobile).toBe(DEFAULT.mobile)
  })

  // ── Clip bounds ────────────────────────────────────────────────

  test("calculates clip bounds from element bounds", () => {
    const clip = calculateClipBounds({ x: 100, y: 200, width: 300, height: 400 }, { width: 1920, height: 1080 })
    expect(clip.x).toBe(100)
    expect(clip.y).toBe(200)
    expect(clip.width).toBe(300)
    expect(clip.height).toBe(400)
  })

  test("clip bounds are clamped to viewport", () => {
    const clip = calculateClipBounds({ x: -50, y: -50, width: 2000, height: 2000 }, { width: 1920, height: 1080 })
    expect(clip.x).toBe(0)
    expect(clip.y).toBe(0)
    expect(clip.width).toBe(1920)
    expect(clip.height).toBe(1080)
  })

  // ── Combined validation ────────────────────────────────────────

  test("validateViewport passes for valid config", () => {
    const r = validateViewport({ width: 1024, height: 768, deviceScaleFactor: 2 })
    expect(r.ok).toBe(true)
  })

  test("validateViewport fails for invalid width", () => {
    const r = validateViewport({ width: 100 })
    expect(r.ok).toBe(false)
  })
})
