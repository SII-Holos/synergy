import { describe, expect, test } from "bun:test"
import { resolveBossWorkflowMenuState } from "../../../src/components/prompt-input/workflow-menu"
import { PI } from "../../../src/components/prompt-input/prompt-input-i18n"

const baseInput = {
  blueprintModeLocked: false,
  bossActive: false,
  planActive: false,
  latticeActive: false,
  lightLoopActive: false,
  working: false,
}

describe("Boss workflow menu state", () => {
  test("enables Boss Mode when inactive and unblocked", () => {
    expect(resolveBossWorkflowMenuState(baseInput)).toEqual({
      action: "enable",
      ariaDisabled: false,
      description: PI.wmRunGoal,
    })
  })

  test("turns an active idle Boss session into a disable action", () => {
    expect(resolveBossWorkflowMenuState({ ...baseInput, bossActive: true })).toEqual({
      action: "disable",
      ariaDisabled: false,
      description: PI.wmClickExitBoss,
      title: PI.wmExitBoss,
    })
  })

  test("keeps active Boss selected but disabled while the session is running", () => {
    expect(resolveBossWorkflowMenuState({ ...baseInput, bossActive: true, working: true })).toEqual({
      action: "none",
      ariaDisabled: true,
      description: PI.wmRecursiveBpActive,
      title: PI.wmStopSessionBeforeWorkflow,
    })
  })

  test("blocks enabling Boss while another workflow mode is active", () => {
    expect(resolveBossWorkflowMenuState({ ...baseInput, planActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmBossUnavailablePlan,
    })

    expect(resolveBossWorkflowMenuState({ ...baseInput, latticeActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmBossUnavailableLattice,
    })

    expect(resolveBossWorkflowMenuState({ ...baseInput, lightLoopActive: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmBossUnavailableLl,
    })

    expect(resolveBossWorkflowMenuState({ ...baseInput, blueprintModeLocked: true })).toMatchObject({
      action: "none",
      ariaDisabled: true,
      title: PI.wmBossUnavailableBp,
    })
  })

  test("lets an idle active Boss session be disabled even if the Blueprint slot is occupied", () => {
    expect(resolveBossWorkflowMenuState({ ...baseInput, blueprintModeLocked: true, bossActive: true })).toEqual({
      action: "disable",
      ariaDisabled: false,
      description: PI.wmClickExitBoss,
      title: PI.wmExitBoss,
    })
  })
})
