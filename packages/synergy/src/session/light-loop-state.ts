import type { Info } from "./types"

export type LightLoopWorkflow = Extract<NonNullable<Info["workflow"]>, { kind: "lightloop" }>
export type LightLoopTerminalStatus = "completed" | "failed" | "cancelled" | "timed_out" | "iteration_exhausted"

export function isLightLoopTerminalStatus(status: LightLoopWorkflow["status"]): status is LightLoopTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "iteration_exhausted"
  )
}

export function isActiveLightLoopWorkflow(workflow: Info["workflow"]): workflow is LightLoopWorkflow {
  return workflow?.kind === "lightloop" && !isLightLoopTerminalStatus(workflow.status)
}
