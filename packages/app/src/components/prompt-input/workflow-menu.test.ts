import { describe, expect, test } from "bun:test"
import { resolveLatticeWorkflowMenuState } from "./workflow-menu"

const baseInput = {
  blueprintModeLocked: false,
  latticeActive: false,
  planActive: false,
  lightLoopActive: false,
  working: false,
}

describe("Lattice workflow menu state", () => {
  test("opens the configuration dialog when Lattice is inactive and unblocked", () => {
    expect(resolveLatticeWorkflowMenuState(baseInput)).toEqual({
      action: "open",
      ariaDisabled: false,
      description: "Run a goal as a recursive Blueprint",
    })
  })

  test("turns an active idle Lattice run into a cancel action", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, latticeActive: true })).toEqual({
      action: "cancel",
      ariaDisabled: false,
      description: "Click to exit Lattice",
      title: "Exit Lattice",
    })
  })

  test("keeps active Lattice selected but disabled while the session is running", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, latticeActive: true, working: true })).toEqual({
      action: "none",
      ariaDisabled: true,
      description: "Recursive Blueprint run active",
      title: "Stop the session before changing workflow modes.",
    })
  })

  test("blocks arming Lattice while another workflow mode is active", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, planActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: "Lattice is unavailable while Plan is active",
    })

    expect(resolveLatticeWorkflowMenuState({ ...baseInput, lightLoopActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: "Lattice is unavailable while Light Loop is active",
    })
  })

  test("lets an idle active Lattice run be cancelled even if the Blueprint slot is occupied", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, blueprintModeLocked: true, latticeActive: true })).toEqual({
      action: "cancel",
      ariaDisabled: false,
      description: "Click to exit Lattice",
      title: "Exit Lattice",
    })
  })
})
