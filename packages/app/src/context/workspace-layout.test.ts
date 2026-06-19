import { describe, expect, test } from "bun:test"
import {
  WORKSPACE_DEFAULT_WIDTH,
  WORKSPACE_MIN_WIDTH,
  WORKSPACE_RAIL_GAP,
  WORKSPACE_RAIL_VISIBLE_MARGIN,
  WORKSPACE_SESSION_MIN_WIDTH,
  WORKSPACE_TABS_MIN_WIDTH,
  clampWorkspaceWidth,
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
