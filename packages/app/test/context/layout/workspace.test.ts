import { describe, expect, test } from "bun:test"
import {
  WORKSPACE_DEFAULT_WIDTH,
  WORKSPACE_MIN_WIDTH,
  WORKSPACE_SESSION_MIN_WIDTH,
  WORKSPACE_TABS_MIN_WIDTH,
  clampWorkspaceWidth,
  computeDefaultWorkspaceWidth,
  computeMaxWorkspaceWidth,
} from "../../../src/context/layout/workspace"

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

describe("computeDefaultWorkspaceWidth", () => {
  test("returns half of the viewport on a 1440px desktop", () => {
    expect(computeDefaultWorkspaceWidth(1440)).toBe(720)
  })

  test("returns half of the viewport on a 1920px desktop", () => {
    expect(computeDefaultWorkspaceWidth(1920)).toBe(960)
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
    expect(computeDefaultWorkspaceWidth(1440, { sessionMinWidth: 780 })).toBe(660)
  })

  test("returns larger than legacy 640 on viewports 1440 and above", () => {
    for (const vp of [1440, 1680, 1920, 2560]) {
      expect(computeDefaultWorkspaceWidth(vp)).toBeGreaterThan(640)
    }
  })
})
