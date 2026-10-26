import { describe, expect, test } from "bun:test"
import {
  IMAGE_VIEWER_FIT_PADDING,
  IMAGE_VIEWER_KEY_PAN_STEP,
  IMAGE_VIEWER_MAX_SCALE,
  IMAGE_VIEWER_ZOOM_STEP,
  actualImageViewer,
  applyImageViewerKey,
  applyImageViewerWheel,
  createImageViewerState,
  fitImageViewer,
  imageViewerDisplayRect,
  imageViewerEntryKey,
  imageViewerFitScale,
  imageViewerScaleBounds,
  imageViewerZoomPercent,
  panImageViewer,
  resizeImageViewer,
  resolveImageViewerKey,
  resolveImageViewerWheel,
  rotateImageViewer,
  setImageViewerImage,
  stepImageViewerZoom,
  zoomImageViewerAt,
  type ImageViewerState,
} from "../../src/components/image-viewer-model"

const LARGE = { width: 4000, height: 3000 }
const SMALL = { width: 120, height: 80 }
const VIEWPORT = { width: 1200, height: 800 }

const fitOf = (image = LARGE, viewport = VIEWPORT) => createImageViewerState({ image, viewport, mode: "fit" })
const actualOf = (image = LARGE, viewport = VIEWPORT) => createImageViewerState({ image, viewport, mode: "free" })

function pointUnder(state: ImageViewerState, point: { x: number; y: number }) {
  const rect = imageViewerDisplayRect(state)
  return { x: (point.x - rect.x) / state.scale, y: (point.y - rect.y) / state.scale }
}

describe("image viewer fit and actual size", () => {
  test("fits a large image inside the padded stage instead of claiming 100%", () => {
    const state = fitOf()
    const rect = imageViewerDisplayRect(state)

    expect(state.scale).toBeCloseTo(752 / 3000, 10)
    expect(rect.width).toBeCloseTo(1002.6666, 3)
    expect(rect.height).toBeCloseTo(752, 6)
    expect(rect.x).toBeCloseTo((VIEWPORT.width - rect.width) / 2, 6)
    expect(rect.y).toBeCloseTo(IMAGE_VIEWER_FIT_PADDING, 6)
    expect(imageViewerZoomPercent(state)).toBe(25)
    expect(imageViewerZoomPercent(state)).not.toBe(100)
  })

  test("actual size is one CSS pixel per source pixel", () => {
    const state = actualOf()
    const rect = imageViewerDisplayRect(state)

    expect(state.scale).toBe(1)
    expect(rect.width).toBe(4000)
    expect(rect.height).toBe(3000)
    expect(imageViewerZoomPercent(state)).toBe(100)
    expect(state.scale).toBeGreaterThan(imageViewerFitScale(fitOf()))
  })

  test("keeps small images at their natural size instead of upscaling them", () => {
    const state = fitOf(SMALL)
    const rect = imageViewerDisplayRect(state)

    expect(state.scale).toBe(1)
    expect(rect).toEqual({ x: 540, y: 360, width: 120, height: 80 })
  })

  test("treats a not-yet-loaded image as natural size", () => {
    expect(imageViewerFitScale({ viewport: VIEWPORT, rotation: 0, padding: IMAGE_VIEWER_FIT_PADDING })).toBe(1)
    const state = createImageViewerState({ viewport: { width: 0, height: 0 }, image: LARGE, mode: "fit" })
    expect(state.scale).toBe(1)
  })

  test("adopts the loaded source size and refits", () => {
    const loading = createImageViewerState({ viewport: VIEWPORT, mode: "fit" })
    expect(loading.scale).toBe(1)

    const loaded = setImageViewerImage(loading, LARGE)
    expect(loaded.scale).toBeCloseTo(752 / 3000, 10)
    expect(loaded.image).toEqual(LARGE)
  })

  test("still fits inside a stage smaller than the normal padding", () => {
    const state = fitOf(LARGE, { width: 40, height: 30 })
    const rect = imageViewerDisplayRect(state)
    expect(rect.width).toBeLessThanOrEqual(40)
    expect(rect.height).toBeLessThanOrEqual(30)
    expect(state.scale).toBeGreaterThan(0)
  })
})

describe("image viewer anchored zoom", () => {
  test("keeps the source point under the cursor fixed while zooming in", () => {
    const before = actualOf()
    const anchor = { x: 900, y: 600 }
    const after = zoomImageViewerAt(before, 2, anchor)

    expect(after.scale).toBe(2)
    expect(after.offset.x).toBeCloseTo(-300, 6)
    expect(after.offset.y).toBeCloseTo(-200, 6)
    expect(pointUnder(after, anchor).x).toBeCloseTo(pointUnder(before, anchor).x, 6)
    expect(pointUnder(after, anchor).y).toBeCloseTo(pointUnder(before, anchor).y, 6)
  })

  test("keeps the source point under the cursor fixed while zooming out", () => {
    const before = actualOf()
    const anchor = { x: 300, y: 200 }
    const after = zoomImageViewerAt(before, 0.5, anchor)

    expect(after.scale).toBe(0.5)
    expect(after.offset).toEqual({ x: -150, y: -100 })
    expect(pointUnder(after, anchor).x).toBeCloseTo(pointUnder(before, anchor).x, 6)
    expect(pointUnder(after, anchor).y).toBeCloseTo(pointUnder(before, anchor).y, 6)
  })

  test("defaults the anchor to the stage center", () => {
    const after = stepImageViewerZoom(actualOf(), "in")

    expect(after.scale).toBeCloseTo(IMAGE_VIEWER_ZOOM_STEP, 10)
    expect(after.offset).toEqual({ x: 0, y: 0 })
  })

  test("caps zoom at the source pixel ceiling and keeps fit reachable", () => {
    const zoomed = zoomImageViewerAt(fitOf(), 100, { x: 600, y: 400 })
    expect(zoomed.scale).toBe(IMAGE_VIEWER_MAX_SCALE)
    expect(imageViewerScaleBounds(zoomed)).toEqual({ min: 752 / 3000, max: IMAGE_VIEWER_MAX_SCALE })

    const fitted = fitImageViewer(zoomed)
    expect(fitted.scale).toBeCloseTo(752 / 3000, 10)
    expect(fitted.mode).toBe("fit")
    expect(fitted.offset).toEqual({ x: 0, y: 0 })
  })

  test("centers the image and clears offset when zooming back out to fit", () => {
    const panned = panImageViewer(actualOf(), { x: -900, y: -700 })
    expect(panned.offset).toEqual({ x: -900, y: -700 })

    const fitted = zoomImageViewerAt(panned, 0.05, { x: 900, y: 600 })
    expect(fitted.scale).toBeCloseTo(752 / 3000, 10)
    expect(fitted.offset).toEqual({ x: 0, y: 0 })
    expect(imageViewerDisplayRect(fitted).y).toBeCloseTo(IMAGE_VIEWER_FIT_PADDING, 6)
  })

  test("returns the same state when a zoom step cannot move", () => {
    const fitted = fitOf()
    expect(stepImageViewerZoom(fitted, "out")).toBe(fitted)
  })
})

describe("image viewer pan bounds", () => {
  test("limits panning to the displayed edges", () => {
    const panned = panImageViewer(actualOf(), { x: 9999, y: 9999 })

    expect(panned.offset).toEqual({ x: 1400, y: 1100 })
    const rect = imageViewerDisplayRect(panned)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
  })

  test("keeps images smaller than the stage centered", () => {
    const fitted = fitOf(SMALL)
    expect(panImageViewer(fitted, { x: 240, y: -160 })).toBe(fitted)
    expect(imageViewerDisplayRect(fitted)).toEqual({ x: 540, y: 360, width: 120, height: 80 })
  })

  test("keeps a panned view reachable after the pan is applied twice", () => {
    const once = panImageViewer(actualOf(), { x: -200, y: -100 })
    const twice = panImageViewer(once, { x: -200, y: -100 })

    expect(once.offset).toEqual({ x: -200, y: -100 })
    expect(twice.offset).toEqual({ x: -400, y: -200 })
  })
})

describe("image viewer rotation", () => {
  test("refits the rotated bounding box inside the stage", () => {
    const rotated = rotateImageViewer(fitOf())
    const rect = imageViewerDisplayRect(rotated)

    expect(rotated.rotation).toBe(90)
    expect(rotated.scale).toBeCloseTo(752 / 4000, 10)
    expect(rect.width).toBeCloseTo(564, 6)
    expect(rect.height).toBeCloseTo(752, 6)
    expect(rect.x).toBeGreaterThanOrEqual(IMAGE_VIEWER_FIT_PADDING - 0.001)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(VIEWPORT.width - IMAGE_VIEWER_FIT_PADDING + 0.001)
    expect(rect.y + rect.height).toBeLessThanOrEqual(VIEWPORT.height + 0.001)
  })

  test("keeps source pixel scale while clamping the rotated pan edges", () => {
    const panned = panImageViewer(actualOf(), { x: 9999, y: 9999 })
    const rotated = rotateImageViewer(panned)

    expect(rotated.scale).toBe(1)
    expect(rotated.offset).toEqual({ x: 900, y: 1100 })
    expect(imageViewerDisplayRect(rotated)).toMatchObject({ width: 3000, height: 4000 })
  })

  test("wraps rotation without leaving the quarter turn set", () => {
    let state = fitOf()
    for (let turn = 1; turn <= 4; turn += 1) state = rotateImageViewer(state)
    expect(state.rotation).toBe(0)
    expect(rotateImageViewer(fitOf(), -1).rotation).toBe(270)
    expect(rotateImageViewer(fitOf(), 2).rotation).toBe(180)
  })
})

describe("image viewer viewport resize", () => {
  test("refits when the window shrinks", () => {
    const resized = resizeImageViewer(fitOf(), { width: 800, height: 600 })
    const rect = imageViewerDisplayRect(resized)

    expect(resized.scale).toBeCloseTo(552 / 3000, 10)
    expect(rect.width).toBeCloseTo(736, 6)
    expect(rect.height).toBeCloseTo(552, 6)
    expect(rect.x).toBeCloseTo((800 - 736) / 2, 6)
    expect(rect.y).toBeCloseTo(IMAGE_VIEWER_FIT_PADDING, 6)
  })

  test("keeps a manual zoom and clamps the offset when the window grows", () => {
    const panned = panImageViewer(actualOf(), { x: 9999, y: 9999 })
    const resized = resizeImageViewer(panned, { width: 1600, height: 1000 })

    expect(resized.scale).toBe(1)
    expect(resized.offset).toEqual({ x: 1200, y: 1000 })
  })

  test("returns the same state when a resize changes nothing", () => {
    const state = fitOf()
    expect(resizeImageViewer(state, VIEWPORT)).toBe(state)
  })
})

describe("image viewer wheel rules", () => {
  test("zooms on an ordinary vertical wheel", () => {
    expect(resolveImageViewerWheel({ deltaX: 0, deltaY: -100 })).toEqual({
      kind: "zoom",
      factor: Math.exp(0.25),
    })
    const zoomed = applyImageViewerWheel(actualOf(), { deltaX: 0, deltaY: -100 }, { x: 900, y: 600 })
    expect(zoomed.scale).toBeCloseTo(Math.exp(0.25), 10)
    expect(pointUnder(zoomed, { x: 900, y: 600 }).x).toBeCloseTo(pointUnder(actualOf(), { x: 900, y: 600 }).x, 6)
  })

  test("zooms on trackpad pinch, which arrives as ctrl plus wheel", () => {
    expect(resolveImageViewerWheel({ deltaX: 0, deltaY: -50, ctrlKey: true })).toEqual({
      kind: "zoom",
      factor: Math.exp(0.5),
    })
    expect(resolveImageViewerWheel({ deltaX: 0, deltaY: -50, metaKey: true })).toEqual({
      kind: "zoom",
      factor: Math.exp(0.5),
    })
  })

  test("pans when horizontal scrolling dominates", () => {
    expect(resolveImageViewerWheel({ deltaX: 120, deltaY: 10, shiftKey: true })).toEqual({
      kind: "pan",
      delta: { x: -120, y: -10 },
    })
    const panned = applyImageViewerWheel(actualOf(), { deltaX: 120, deltaY: 10 })
    expect(panned.scale).toBe(1)
    expect(panned.offset).toEqual({ x: -120, y: -10 })
  })

  test("ignores an empty wheel event and caps a violent pinch", () => {
    expect(resolveImageViewerWheel({ deltaX: 0, deltaY: 0 })).toBeUndefined()
    expect(resolveImageViewerWheel({ deltaX: 0, deltaY: -3000, ctrlKey: true })).toEqual({
      kind: "zoom",
      factor: 2,
    })
  })
})

describe("image viewer keyboard rules", () => {
  test("maps bare arrows to a bounded pan", () => {
    expect(resolveImageViewerKey({ key: "ArrowLeft" })).toEqual({
      kind: "pan",
      delta: { x: -IMAGE_VIEWER_KEY_PAN_STEP, y: 0 },
    })
    expect(resolveImageViewerKey({ key: "ArrowUp" })).toEqual({
      kind: "pan",
      delta: { x: 0, y: -IMAGE_VIEWER_KEY_PAN_STEP },
    })
    expect(applyImageViewerKey(actualOf(), { key: "ArrowRight" }).offset).toEqual({
      x: IMAGE_VIEWER_KEY_PAN_STEP,
      y: 0,
    })
    expect(applyImageViewerKey(fitOf(), { key: "ArrowRight" }).offset).toEqual({ x: 0, y: 0 })
  })

  test("maps zoom, fit, actual and rotate keys", () => {
    expect(resolveImageViewerKey({ key: "+" })).toEqual({ kind: "zoom", direction: "in" })
    expect(resolveImageViewerKey({ key: "=" })).toEqual({ kind: "zoom", direction: "in" })
    expect(resolveImageViewerKey({ key: "-" })).toEqual({ kind: "zoom", direction: "out" })
    expect(resolveImageViewerKey({ key: "0" })).toEqual({ kind: "fit" })
    expect(resolveImageViewerKey({ key: "1" })).toEqual({ kind: "actual" })
    expect(resolveImageViewerKey({ key: "r" })).toEqual({ kind: "rotate" })
    expect(applyImageViewerKey(actualOf(), { key: "0" }).scale).toBeCloseTo(752 / 3000, 10)
    expect(applyImageViewerKey(fitOf(), { key: "1" }).scale).toBe(1)
  })

  test("leaves application shortcuts alone when a modifier is held", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }])
      expect(resolveImageViewerKey({ key: "ArrowLeft", ...modifier })).toBeUndefined()
    expect(resolveImageViewerKey({ key: "Escape" })).toBeUndefined()
    expect(resolveImageViewerKey({ key: "a" })).toBeUndefined()
  })
})

describe("image viewer entry identity", () => {
  test("separates entries that share a source but differ by id", () => {
    expect(imageViewerEntryKey({ id: "first", src: "blob:same" })).toBe("first\u0000blob:same")
    expect(imageViewerEntryKey({ id: "first", src: "blob:same" })).not.toBe(
      imageViewerEntryKey({ id: "second", src: "blob:same" }),
    )
    expect(imageViewerEntryKey({ id: "first", src: "blob:one" })).not.toBe(
      imageViewerEntryKey({ id: "first", src: "blob:two" }),
    )
  })
})
