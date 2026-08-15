import { describe, expect, test } from "bun:test"
import { layoutSizeForZoom } from "../../src/context/zoom-layout"

describe("layoutSizeForZoom", () => {
  test("converts viewport pixels into CSS zoom coordinates", () => {
    expect(layoutSizeForZoom(720, 1.2)).toBe(600)
    expect(layoutSizeForZoom(720, 0.5)).toBe(1440)
  })

  test("keeps the default scale unchanged", () => {
    expect(layoutSizeForZoom(1280, 1)).toBe(1280)
  })

  test("falls back safely for invalid scales", () => {
    expect(layoutSizeForZoom(720, 0)).toBe(720)
    expect(layoutSizeForZoom(720, Number.NaN)).toBe(720)
  })
})
