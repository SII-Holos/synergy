import type { MessageDescriptor } from "@lingui/core"
import { PI } from "./prompt-input-i18n"

export type LatticeWorkflowMenuAction = "open" | "cancel" | "none"

export type BossWorkflowMenuAction = "enable" | "disable" | "none"

export type BossWorkflowMenuState = {
  action: BossWorkflowMenuAction
  ariaDisabled: boolean
  description: MessageDescriptor
  title?: MessageDescriptor
}

export function resolveBossWorkflowMenuState(input: {
  blueprintModeLocked: boolean
  bossActive: boolean
  planActive: boolean
  latticeActive: boolean
  lightLoopActive: boolean
  working: boolean
}): BossWorkflowMenuState {
  if (input.bossActive) {
    if (input.working) {
      return {
        action: "none",
        ariaDisabled: true,
        description: PI.wmRecursiveBpActive,
        title: PI.wmStopSessionBeforeWorkflow,
      }
    }
    return {
      action: "disable",
      ariaDisabled: false,
      description: PI.wmClickExitBoss,
      title: PI.wmExitBoss,
    }
  }

  if (input.blueprintModeLocked) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmBossUnavailableBp,
    }
  }

  if (input.planActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmBossUnavailablePlan,
    }
  }

  if (input.latticeActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmBossUnavailableLattice,
    }
  }

  if (input.lightLoopActive) {
    return {
      action: "none",
      ariaDisabled: true,
      description: PI.wmRunGoal,
      title: PI.wmBossUnavailableLl,
    }
  }

  return {
    action: "enable",
    ariaDisabled: false,
    description: PI.wmRunGoal,
  }
}

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
