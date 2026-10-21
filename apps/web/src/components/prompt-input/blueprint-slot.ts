import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import type { BlueprintSlot } from "./types"
import { blueprintLoopFeatureAvailable } from "../note/blueprint-run-session"

export type BlueprintSlotDisplay = {
  slot: BlueprintSlot
  mode: string
}

type DisplayLoop = Pick<BlueprintLoopInfo, "id" | "noteID" | "title" | "runMode" | "status"> &
  Partial<Pick<BlueprintLoopInfo, "source">>

const TERMINAL_BLUEPRINT_LOOP_STATUSES = new Set(["completed", "failed", "cancelled"])

export function isTerminalBlueprintLoopStatus(status?: string | null) {
  return !!status && TERMINAL_BLUEPRINT_LOOP_STATUSES.has(status)
}

export function resolveBlueprintLoopState<Loop extends Pick<BlueprintLoopInfo, "id">>(input: {
  loop?: Loop | null
  activeLoopID?: string | null
}) {
  const activeLoopID = input.activeLoopID || undefined
  return {
    activeLoopID,
    loop: activeLoopID && input.loop?.id === activeLoopID ? input.loop : undefined,
  }
}

export function resolveBlueprintSlotDisplay(input: {
  localSlot?: BlueprintSlot | null
  sessionLoop?: DisplayLoop | null
  activeLoopID?: string | null
  hasFeature?: (id: string) => boolean
}): BlueprintSlotDisplay | null {
  const hasFeature = input.hasFeature ?? (() => true)
  if (!hasFeature("blueprint")) return null
  if (input.localSlot) {
    if (input.localSlot.type === "loop" && !blueprintLoopFeatureAvailable(input.localSlot, hasFeature)) return null
    return {
      slot: input.localSlot,
      mode: input.localSlot.type === "pending" ? "pending" : "armed",
    }
  }

  const state = resolveBlueprintLoopState({ loop: input.sessionLoop, activeLoopID: input.activeLoopID })
  const loop = state.loop
  if (!state.activeLoopID || !loop) return null
  if (!blueprintLoopFeatureAvailable(loop, hasFeature)) return null

  return {
    slot: {
      type: "loop",
      loopID: loop.id,
      ...(loop.source ? { source: loop.source } : {}),
      noteID: loop.noteID,
      title: loop.title,
      runMode: loop.runMode ?? "current",
    },
    mode: loop.status,
  }
}

export const BLUEPRINT_ERROR_DEFAULT = "Request failed"

export function blueprintRequestErrorMessage(err: unknown) {
  if (err && typeof err === "object") {
    const data = (err as { data?: { message?: unknown } }).data
    if (data && typeof data.message === "string" && data.message.length > 0) return data.message

    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  if (err instanceof Error && err.message) return err.message
  return BLUEPRINT_ERROR_DEFAULT
}
