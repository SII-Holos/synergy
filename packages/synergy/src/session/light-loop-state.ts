import z from "zod"
import type { Info } from "./types"

export type LightLoopWorkflow = Extract<NonNullable<Info["workflow"]>, { kind: "lightloop" }>
export const LightLoopTerminalStatus = z.enum(["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"])
export type LightLoopTerminalStatus = z.infer<typeof LightLoopTerminalStatus>

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
