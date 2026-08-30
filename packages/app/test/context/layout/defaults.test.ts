import { describe, expect, test } from "bun:test"
import {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  effectiveSidebarWidth,
} from "../../../src/context/layout/defaults"

describe("sidebar width defaults", () => {
  test("clamps widths into the adjustable band", () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 80)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(340.6)).toBe(341)
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 500)).toBe(SIDEBAR_WIDTH_MAX)
  })

  test("keeps the persisted band floor at or above the collapse threshold", () => {
    expect(SIDEBAR_WIDTH_MIN).toBeGreaterThanOrEqual(SIDEBAR_COLLAPSE_THRESHOLD)
  })

  test("ignores stored width unless the user actually resized", () => {
    expect(effectiveSidebarWidth({ width: 280 })).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(effectiveSidebarWidth({ width: 280, resized: false })).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(effectiveSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  test("restores a flagged width clamped to the band", () => {
    expect(effectiveSidebarWidth({ width: 9999, resized: true })).toBe(SIDEBAR_WIDTH_MAX)
    expect(effectiveSidebarWidth({ width: 360, resized: true })).toBe(360)
    expect(effectiveSidebarWidth({ width: Number.NaN, resized: true })).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})
