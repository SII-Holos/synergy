import { describe, expect, test } from "bun:test"
import { createInitialLayoutPreferences, shouldPresentInitialSideWorkspace } from "../../../src/context/layout/defaults"

describe("initial layout discovery", () => {
  test("shows both navigation and workspace discovery surfaces to a new desktop user", () => {
    const defaults = createInitialLayoutPreferences()

    expect(defaults.sidebar.opened).toBe(true)
    expect(defaults.discovery.initialSurfacesPresented).toBe(false)
    expect(
      shouldPresentInitialSideWorkspace({
        ready: true,
        desktop: true,
        presented: defaults.discovery.initialSurfacesPresented,
      }),
    ).toBe(true)
  })

  test("does not open the side workspace on mobile, before persistence is ready, or after discovery", () => {
    expect(shouldPresentInitialSideWorkspace({ ready: true, desktop: false, presented: false })).toBe(false)
    expect(shouldPresentInitialSideWorkspace({ ready: false, desktop: true, presented: false })).toBe(false)
    expect(shouldPresentInitialSideWorkspace({ ready: true, desktop: true, presented: true })).toBe(false)
  })
})
