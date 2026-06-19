import { describe, expect, test } from "bun:test"
import {
  WORKSPACE_DEFAULT_WIDTH,
  WORKSPACE_MIN_WIDTH,
  WORKSPACE_RAIL_GAP,
  WORKSPACE_RAIL_VISIBLE_MARGIN,
  WORKSPACE_SESSION_MIN_WIDTH,
  WORKSPACE_TABS_MIN_WIDTH,
  clampWorkspaceWidth,
  computeDefaultWorkspaceWidth,
  computeMaxWorkspaceWidth,
  computeWorkspaceRailRight,
} from "./workspace-layout"

describe("workspace layout constants", () => {
  test("uses a wider default workspace", () => {
    expect(WORKSPACE_DEFAULT_WIDTH).toBe(640)
  })

  test("keeps the drawer usable at its minimum", () => {
    expect(WORKSPACE_MIN_WIDTH).toBe(300)
  })

  test("reserves a narrow auxiliary session column", () => {
    expect(WORKSPACE_SESSION_MIN_WIDTH).toBe(350)
  })

  test("reserves room for an open tabs panel", () => {
    expect(WORKSPACE_TABS_MIN_WIDTH).toBe(200)
  })

  test("keeps the dock close to the workspace edge", () => {
    expect(WORKSPACE_RAIL_GAP).toBe(8)
    expect(WORKSPACE_RAIL_VISIBLE_MARGIN).toBe(60)
  })
})

describe("computeMaxWorkspaceWidth", () => {
  test("lets workspace dominate a 1440px viewport", () => {
    expect(computeMaxWorkspaceWidth(1440)).toBe(1090)
  })

  test("lets workspace dominate a 1920px viewport", () => {
    expect(computeMaxWorkspaceWidth(1920)).toBe(1570)
  })

  test("reserves tabs width when tabs are open", () => {
    expect(computeMaxWorkspaceWidth(1440, { tabsMinWidth: WORKSPACE_TABS_MIN_WIDTH })).toBe(890)
  })

  test("honors a custom session minimum", () => {
    expect(computeMaxWorkspaceWidth(1440, { sessionMinWidth: 420 })).toBe(1020)
  })

  test("never returns below workspace minimum on small viewports", () => {
    expect(computeMaxWorkspaceWidth(560)).toBe(WORKSPACE_MIN_WIDTH)
  })
})

describe("clampWorkspaceWidth", () => {
  test("returns widths inside the allowed range", () => {
    expect(clampWorkspaceWidth(700, 1440)).toBe(700)
  })

  test("clamps below the drawer minimum", () => {
    expect(clampWorkspaceWidth(200, 1440)).toBe(WORKSPACE_MIN_WIDTH)
  })

  test("clamps above the session-preserving maximum", () => {
    expect(clampWorkspaceWidth(1300, 1440)).toBe(1090)
  })

  test("accounts for tabs when clamping", () => {
    expect(clampWorkspaceWidth(1000, 1440, { tabsMinWidth: WORKSPACE_TABS_MIN_WIDTH })).toBe(890)
  })

  test("default width passes through normal desktop viewports", () => {
    expect(clampWorkspaceWidth(WORKSPACE_DEFAULT_WIDTH, 1024)).toBe(WORKSPACE_DEFAULT_WIDTH)
    expect(clampWorkspaceWidth(WORKSPACE_DEFAULT_WIDTH, 1440)).toBe(WORKSPACE_DEFAULT_WIDTH)
  })

  test("clamping is idempotent", () => {
    const width = clampWorkspaceWidth(1300, 1440)
    expect(clampWorkspaceWidth(width, 1440)).toBe(width)
  })
})

describe("computeWorkspaceRailRight", () => {
  test("tracks the workspace edge while there is room", () => {
    expect(computeWorkspaceRailRight(WORKSPACE_DEFAULT_WIDTH, 1440)).toBe(WORKSPACE_DEFAULT_WIDTH + WORKSPACE_RAIL_GAP)
  })

  test("keeps the dock visible when workspace is dominant", () => {
    expect(computeWorkspaceRailRight(1500, 1440)).toBe(1380)
  })

  test("never positions the dock closer than the default gap", () => {
    expect(computeWorkspaceRailRight(0, 40)).toBe(WORKSPACE_RAIL_GAP)
  })
})

describe("computeDefaultWorkspaceWidth", () => {
  test("returns roughly 3/5 of remaining space on a 1440px desktop", () => {
    const width = computeDefaultWorkspaceWidth(1440)
    // remaining after session min: 1440 - 350 = 1090, 3/5 ≈ 654
    expect(width).toBeGreaterThan(640)
    expect(width).toBeLessThanOrEqual(800)
  })

  test("returns roughly 3/5 of remaining space on a 1920px desktop", () => {
    const width = computeDefaultWorkspaceWidth(1920)
    // remaining: 1920 - 350 = 1570, 3/5 ≈ 942
    expect(width).toBeGreaterThan(640)
    expect(width).toBeLessThanOrEqual(1100)
  })

  test("scales down on narrower viewports", () => {
    const width = computeDefaultWorkspaceWidth(1024)
    expect(width).toBeGreaterThanOrEqual(WORKSPACE_MIN_WIDTH)
    expect(width).toBeLessThanOrEqual(600)
  })

  test("never returns less than the workspace minimum", () => {
    const width = computeDefaultWorkspaceWidth(400)
    expect(width).toBeGreaterThanOrEqual(WORKSPACE_MIN_WIDTH)
  })

  test("respects custom session minimum", () => {
    const width = computeDefaultWorkspaceWidth(1440, { sessionMinWidth: 420 })
    // remaining: 1440 - 420 = 1020, 3/5 = 612 — less than legacy 640 is expected with larger session min
    expect(width).toBeGreaterThan(600)
    expect(width).toBeLessThan(640)
  })

  test("returns larger than legacy 640 on viewports 1440 and above", () => {
    for (const vp of [1440, 1680, 1920, 2560]) {
      expect(computeDefaultWorkspaceWidth(vp)).toBeGreaterThan(640)
    }
  })
})
