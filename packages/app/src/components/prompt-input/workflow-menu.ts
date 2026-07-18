import type { MessageDescriptor } from "@lingui/core"
import { PI } from "./prompt-input-i18n"

export type LatticeWorkflowMenuAction = "open" | "cancel" | "none"

export type LatticeWorkflowMenuStateInput = {
  blueprintModeLocked: boolean
  latticeActive: boolean
  planActive: boolean
  lightLoopActive: boolean
  working: boolean
}

export type LatticeWorkflowMenuState = {
  action: LatticeWorkflowMenuAction
  ariaDisabled: boolean
  description: MessageDescriptor
  title?: MessageDescriptor
}

export function resolveLatticeWorkflowMenuState(input: LatticeWorkflowMenuStateInput): LatticeWorkflowMenuState {
  if (input.latticeActive) {
    if (input.working) {
      return {
        action: "none",
        ariaDisabled: true,
        description: PI.wmRecursiveBpActive,
        title: PI.wmStopSessionBeforeWorkflow,
      }
    }

    return {
      action: "cancel",
      ariaDisabled: false,
      description: PI.wmClickExitLattice,
      title: PI.wmExitLattice,
    }
  }

  if (input.blueprintModeLocked) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmLatticeUnavailableBp,
    }
  }

  if (input.planActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmLatticeUnavailablePlan,
    }
  }

  if (input.lightLoopActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmLatticeUnavailableLl,
    }
  }

  return {
    action: "open",
    ariaDisabled: false,
    description: PI.wmRunGoal,
  }
}
