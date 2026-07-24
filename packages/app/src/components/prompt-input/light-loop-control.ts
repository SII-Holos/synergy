export type LightLoopControlState =
  | { mode: "editable"; reason: "editable" }
  | { mode: "readOnly"; reason: "inactive" | "reviewPending" | "working" }

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"])

export function isActiveLightLoopWorkflow(
  workflow: { kind?: string; status?: string } | undefined,
): workflow is { kind: "lightloop"; status?: string } {
  return workflow?.kind === "lightloop" && !TERMINAL_STATUSES.has(workflow.status ?? "")
}

export function resolveLightLoopControlState(input: {
  active: boolean
  working: boolean
  reviewPending: boolean
}): LightLoopControlState {
  if (!input.active) return { mode: "readOnly", reason: "inactive" }
  if (input.reviewPending) return { mode: "readOnly", reason: "reviewPending" }
  if (input.working) return { mode: "readOnly", reason: "working" }
  return { mode: "editable", reason: "editable" }
}
