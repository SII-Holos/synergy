export type LightLoopControlState =
  | { mode: "editable"; description: string }
  | { mode: "readOnly"; description: string }

export function resolveLightLoopControlState(input: {
  active: boolean
  working: boolean
  reviewPending: boolean
}): LightLoopControlState {
  if (!input.active) {
    return {
      mode: "readOnly",
      description: "Light Loop is no longer active. Close this dialog to continue.",
    }
  }
  if (input.reviewPending) {
    return {
      mode: "readOnly",
      description: "Completion review is pending. Stop or finish the review before changing the task.",
    }
  }
  if (input.working) {
    return {
      mode: "readOnly",
      description: "The session is running. Stop it or wait until it is idle before changing the task.",
    }
  }
  return {
    mode: "editable",
    description: "Changes apply from the next model step.",
  }
}
