import type { BlueprintLoopInfo, Message, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import type { BlueprintSlot } from "./types"

export type LoopTerminal = {
  status: "completed" | "failed" | "cancelled" | "timed_out" | "iteration_exhausted"
  instructions: string
  error?: string
  createdAt: number
}
export type LoopStage =
  | "bound"
  | "running"
  | "auditing"
  | "paused"
  | "rework"
  | "resolving"
  | "unavailable"
  | LoopTerminal["status"]
export type LoopDisplay = {
  kind: "lightloop" | "blueprint"
  stage: LoopStage
  title: string
  detail?: string
  reason?: string
  reviewerSessionID?: string
  noteID?: string
  terminal: boolean
  pending?: boolean
}
export type LoopHistoryHint = { blueprintID?: string; light?: string; lightReview?: string }

export function resolveLoopDisplay(input: {
  localBlueprint?: BlueprintSlot | null
  blueprint?: BlueprintLoopInfo | null
  blueprintBinding?: Session["blueprint"]
  blueprintUnavailable?: boolean
  workflow?: Session["workflow"]
  lightPending?: boolean
  lightTerminal?: LoopTerminal
  awaitingTerminal?: { instructions: string; error?: boolean }
  status: SessionStatus
}): LoopDisplay | undefined {
  if (input.localBlueprint)
    return {
      kind: "blueprint",
      stage: "bound",
      title: input.localBlueprint.title,
      noteID: input.localBlueprint.noteID,
      terminal: false,
      pending: true,
    }
  const workflow = input.workflow
  if (workflow?.kind === "lightloop") {
    const terminal =
      workflow.status &&
      ["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"].includes(workflow.status)
    return {
      kind: "lightloop",
      stage: terminal
        ? (workflow.status as LoopTerminal["status"])
        : input.status.type === "paused"
          ? "paused"
          : workflow.stopRequest || workflow.status === "reviewing"
            ? "auditing"
            : workflow.review?.lastReason
              ? "rework"
              : input.status.type === "idle"
                ? "bound"
                : "running",
      title: workflow.instructions,
      reason: workflow.terminalError ?? (workflow.status === "completed" ? undefined : workflow.review?.lastReason),
      detail: workflow.stopRequest?.summary,
      reviewerSessionID: workflow.stopRequest?.reviewSessionID,
      terminal: !!terminal,
    }
  }
  if (input.lightPending) return { kind: "lightloop", stage: "bound", title: "", terminal: false, pending: true }
  if (input.awaitingTerminal && !input.blueprintBinding?.loopID)
    return {
      kind: "lightloop",
      stage: input.awaitingTerminal.error ? "unavailable" : "resolving",
      title: input.awaitingTerminal.instructions,
      terminal: true,
    }
  const loop = input.blueprint
  const terminal = loop && ["completed", "failed", "cancelled"].includes(loop.status)
  // A newer Light Loop result supersedes an older Blueprint result in the same Session.
  if (
    input.lightTerminal &&
    !input.blueprintBinding?.loopID &&
    (!loop || (terminal && input.lightTerminal.createdAt > loop.time.updated))
  ) {
    return {
      kind: "lightloop",
      stage: input.lightTerminal.status,
      title: input.lightTerminal.instructions,
      reason: input.lightTerminal.error,
      terminal: true,
    }
  }
  if (!loop)
    return input.blueprintBinding?.loopID
      ? {
          kind: "blueprint",
          stage: input.blueprintUnavailable
            ? "unavailable"
            : input.blueprintBinding.phase === "auditing"
              ? "auditing"
              : "bound",
          title: "",
          terminal: false,
        }
      : undefined
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
    terminal: !!terminal,
  }
}

export function resolveLoopHistoryHint(messages: readonly Pick<Message, "id" | "metadata">[]): LoopHistoryHint {
  let blueprintID: string | undefined
  let light: string | undefined
  let lightReview: string | undefined
  for (let index = messages.length - 1; index >= 0 && (!blueprintID || !light); index--) {
    const message = messages[index],
      metadata = message.metadata
    const source = typeof metadata?.source === "string" ? metadata.source : ""
    if (!blueprintID && source.startsWith("blueprint_loop_") && typeof metadata?.loopID === "string")
      blueprintID = metadata.loopID
    if (!light && (source.startsWith("light_loop_") || metadata?.workflow === "lightloop")) {
      light = message.id
      if (source === "light_loop_approved" && typeof metadata?.sourceSessionID === "string")
        lightReview = metadata.sourceSessionID
    }
  }
  return { blueprintID, light, lightReview }
}
