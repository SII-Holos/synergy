import { describe, expect, test } from "bun:test"
import { resolveLatticeWorkflowMenuState } from "./workflow-menu"
import { PI } from "./prompt-input-i18n"

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
      description: PI.wmRunGoal,
    })
  })

  test("turns an active idle Lattice run into a cancel action", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, latticeActive: true })).toEqual({
      action: "cancel",
      ariaDisabled: false,
      description: PI.wmClickExitLattice,
      title: PI.wmExitLattice,
    })
  })

  test("keeps active Lattice selected but disabled while the session is running", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, latticeActive: true, working: true })).toEqual({
      action: "none",
      ariaDisabled: true,
      description: PI.wmRecursiveBpActive,
      title: PI.wmStopSessionBeforeWorkflow,
    })
  })

  test("blocks arming Lattice while another workflow mode is active", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, planActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmLatticeUnavailablePlan,
    })

    expect(resolveLatticeWorkflowMenuState({ ...baseInput, lightLoopActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmLatticeUnavailableLl,
    })
  })

  test("lets an idle active Lattice run be cancelled even if the Blueprint slot is occupied", () => {
    expect(resolveLatticeWorkflowMenuState({ ...baseInput, blueprintModeLocked: true, latticeActive: true })).toEqual({
      action: "cancel",
      ariaDisabled: false,
      description: PI.wmClickExitLattice,
      title: PI.wmExitLattice,
    })
  })
})
