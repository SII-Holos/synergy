import { describe, expect, test } from "bun:test"
import { createInitialLayoutDefaults, shouldRevealInitialSideWorkspace } from "../../../src/context/layout/defaults"

describe("initial layout discovery", () => {
  test("expands the navigation and offers the side workspace to a fresh desktop user", () => {
    const layout = createInitialLayoutDefaults()

    expect(layout.sidebar.opened).toBe(true)
    expect(layout.mobileSidebar.opened).toBe(false)
    expect(layout.rightSidebar.opened).toBe(false)
    expect(layout.sideWorkspaceDiscovered).toBe(false)
    expect(
      shouldRevealInitialSideWorkspace({
        ready: true,
        desktop: true,
        discovered: layout.sideWorkspaceDiscovered,
      }),
    ).toBe(true)
  })

  test("does not consume the discovery state on mobile or before persistence is ready", () => {
    expect(shouldRevealInitialSideWorkspace({ ready: false, desktop: true, discovered: false })).toBe(false)
    expect(shouldRevealInitialSideWorkspace({ ready: true, desktop: false, discovered: false })).toBe(false)
    expect(shouldRevealInitialSideWorkspace({ ready: true, desktop: true, discovered: true })).toBe(false)
  })
})
