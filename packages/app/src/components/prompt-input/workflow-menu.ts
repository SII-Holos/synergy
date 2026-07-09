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

const stopSessionTitle = "Stop the session before changing workflow modes."

export function resolveLatticeWorkflowMenuState(input: LatticeWorkflowMenuStateInput): LatticeWorkflowMenuState {
  if (input.latticeActive) {
    if (input.working) {
      return {
        action: "none",
        ariaDisabled: true,
        description: "Recursive Blueprint run active",
        title: stopSessionTitle,
      }
    }

    return {
      action: "cancel",
      ariaDisabled: false,
      description: "Click to exit Lattice",
      title: "Exit Lattice",
    }
  }

  if (input.blueprintModeLocked) {
    return {
      action: "none",
      ariaDisabled: true,
      description: "Run a goal as a recursive Blueprint",
      title: "Lattice is unavailable while a Blueprint is equipped",
    }
  }

  if (input.planActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: "Run a goal as a recursive Blueprint",
      title: "Lattice is unavailable while Plan is active",
    }
  }

  if (input.lightLoopActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: "Run a goal as a recursive Blueprint",
      title: "Lattice is unavailable while Light Loop is active",
    }
  }

  return {
    action: "open",
    ariaDisabled: false,
    description: "Run a goal as a recursive Blueprint",
  }
}
