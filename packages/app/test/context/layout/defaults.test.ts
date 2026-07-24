import { describe, expect, test } from "bun:test"
import { createInitialLayoutDefaults } from "../../../src/context/layout/defaults"

describe("initial layout defaults", () => {
  test("expands only the primary navigation for a fresh user", () => {
    const layout = createInitialLayoutDefaults()

    expect(layout.sidebar.opened).toBe(true)
    expect(layout.mobileSidebar.opened).toBe(false)
    expect(layout.rightSidebar.opened).toBe(false)
    expect("sideWorkspaceDiscovered" in layout).toBe(false)
  })
})
