export type LightLoopControlState =
  | { mode: "editable"; reason: "editable" }
  | { mode: "readOnly"; reason: "inactive" | "reviewPending" | "working" }

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
