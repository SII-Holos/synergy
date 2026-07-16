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
  description: string
  title?: string
}

export function resolveLatticeWorkflowMenuState(input: LatticeWorkflowMenuStateInput): LatticeWorkflowMenuState {
  if (input.latticeActive) {
    if (input.working) {
      return {
        action: "none",
        ariaDisabled: true,
        description: PI.wmRecursiveBpActive.message,
        title: PI.wmStopSessionBeforeWorkflow.message,
      }
    }

    return {
      action: "cancel",
      ariaDisabled: false,
      description: PI.wmClickExitLattice.message,
      title: PI.wmExitLattice.message,
    }
  }

  if (input.blueprintModeLocked) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal.message,
      title: PI.wmLatticeUnavailableBp.message,
    }
  }

  if (input.planActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal.message,
      title: PI.wmLatticeUnavailablePlan.message,
    }
  }

  if (input.lightLoopActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal.message,
      title: PI.wmLatticeUnavailableLl.message,
    }
  }

  return {
    action: "open",
    ariaDisabled: false,
    description: PI.wmRunGoal.message,
  }
}
