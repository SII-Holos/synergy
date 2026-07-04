import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import type { BlueprintSlot } from "./types"

export type BlueprintSlotDisplay = {
  slot: BlueprintSlot
  mode: string
}

export type BlueprintDisplayLoop = Pick<
  BlueprintLoopInfo,
  "id" | "noteID" | "title" | "runMode" | "status" | "sessionID"
>

type DisplayLoop = BlueprintDisplayLoop

const TERMINAL_BLUEPRINT_LOOP_STATUSES = new Set(["completed", "failed", "cancelled"])

export function isTerminalBlueprintLoopStatus(status?: string | null) {
  return !!status && TERMINAL_BLUEPRINT_LOOP_STATUSES.has(status)
}

export function resolveEffectiveBlueprintActiveLoopID(input: {
  sessionID?: string | null
  sessionActiveLoopID?: string | null
  optimisticLoopID?: string | null
  sessionLoop?: Pick<BlueprintDisplayLoop, "id" | "sessionID" | "status"> | null
}): string | undefined {
  // 1. Prefer sessionActiveLoopID when present.
  if (input.sessionActiveLoopID) return input.sessionActiveLoopID

  // 2. Bridge: sessionLoop is non-terminal and belongs to current session.
  if (
    input.sessionLoop &&
    !isTerminalBlueprintLoopStatus(input.sessionLoop.status) &&
    input.sessionLoop.sessionID === input.sessionID
  ) {
    return input.sessionLoop.id
  }

  // 3. Optimistic loop ID matches sessionLoop and sessionLoop is non-terminal.
  if (
    input.optimisticLoopID &&
    input.sessionLoop &&
    input.sessionLoop.id === input.optimisticLoopID &&
    !isTerminalBlueprintLoopStatus(input.sessionLoop.status)
  ) {
    return input.sessionLoop.id
  }

  return undefined
}

export function resolveBlueprintSlotDisplay(input: {
  localSlot?: BlueprintSlot | null
  sessionLoop?: DisplayLoop | null
  activeLoopID?: string | null
}): BlueprintSlotDisplay | null {
  if (input.localSlot) {
    return {
      slot: input.localSlot,
      mode: input.localSlot.type === "pending" ? "pending" : "armed",
    }
  }

  const loop = input.sessionLoop
  if (!loop) return null
  if (!input.activeLoopID || loop.id !== input.activeLoopID) return null
  if (isTerminalBlueprintLoopStatus(loop.status)) return null

  return {
    slot: {
      type: "loop",
      loopID: loop.id,
      noteID: loop.noteID,
      title: loop.title,
      runMode: loop.runMode ?? "current",
    },
    mode: loop.status,
  }
}

export function blueprintRequestErrorMessage(err: unknown) {
  if (err && typeof err === "object") {
    const data = (err as { data?: { message?: unknown } }).data
    if (data && typeof data.message === "string" && data.message.length > 0) return data.message

    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  if (err instanceof Error && err.message) return err.message
  return "Request failed"
}
