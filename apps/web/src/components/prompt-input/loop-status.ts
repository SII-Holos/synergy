import type { BlueprintLoopInfo, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { isTerminalBlueprintLoopStatus, resolveBlueprintLoopState } from "./blueprint-slot"

export type LoopTerminal = {
  status: "completed" | "failed" | "cancelled" | "timed_out" | "iteration_exhausted"
  instructions: string
  error?: string
  createdAt: number
}
export type LoopStage =
  "bound" | "running" | "auditing" | "paused" | "rework" | "resolving" | "unavailable" | LoopTerminal["status"]
export type LoopDisplay = {
  kind: "lightloop" | "blueprint"
  stage: LoopStage
  title: string
  detail?: string
  reason?: string
  reviewerSessionID?: string
  noteID?: string
  terminal: boolean
}
export function resolveLoopDisplay(input: {
  blueprint?: BlueprintLoopInfo | null
  blueprintBinding?: Session["blueprint"]
  blueprintUnavailable?: boolean
  workflow?: Session["workflow"]
  status: SessionStatus
}): LoopDisplay | undefined {
  const { activeLoopID, loop } = resolveBlueprintLoopState({
    loop: input.blueprint,
    activeLoopID: input.blueprintBinding?.loopID,
  })
  const workflow = input.workflow
  if (workflow?.kind === "lightloop") {
    return {
      kind: "lightloop",
      stage: input.status.type === "paused" ? "paused" : input.status.type === "idle" ? "bound" : "running",
      title: workflow.instructions,
      terminal: false,
    }
  }
  if (!activeLoopID) return
  if (!loop || input.blueprintUnavailable)
    return {
      kind: "blueprint",
      stage: input.blueprintUnavailable
        ? "unavailable"
        : input.blueprintBinding?.phase === "auditing"
          ? "auditing"
          : "bound",
      title: loop?.title ?? "",
      noteID: loop?.noteID,
      terminal: false,
    }
  const terminal = isTerminalBlueprintLoopStatus(loop.status)
  return {
    kind: "blueprint",
    stage: terminal
      ? (loop.status as "completed" | "failed" | "cancelled")
      : input.status.type === "paused"
        ? "paused"
        : loop.status === "auditing" || loop.stopRequest
          ? "auditing"
          : loop.audit?.lastReason
            ? "rework"
            : loop.status === "armed"
              ? "bound"
              : "running",
    title: loop.title,
    reason: loop.error ?? (loop.status === "completed" ? undefined : loop.audit?.lastReason),
    detail: terminal ? loop.summary : loop.stopRequest?.summary,
    reviewerSessionID: loop.auditSessionID,
    noteID: loop.noteID,
    terminal,
  }
}
