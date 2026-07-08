import type { Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { blueprintNoteWriteFocusRequest } from "@/components/note/blueprint-note-focus"

export type PlanBlueprintOffer = {
  key: string
  noteID: string
  title: string
  scopeID?: string
}

export type PlanBlueprintOfferState = {
  offer: PlanBlueprintOffer | null
  muted: boolean
}

export type PlanBlueprintOfferEvent =
  | { type: "captured"; offer: PlanBlueprintOffer }
  | { type: "dismissed"; key: string }
  | { type: "muted" }
  | { type: "equipped"; key: string }
  | { type: "plan_exited" }

export const emptyPlanBlueprintOfferState: PlanBlueprintOfferState = {
  offer: null,
  muted: false,
}

export function planBlueprintOfferKey(input: { partID: string; sessionID: string; noteID: string }) {
  return `${input.sessionID}:${input.partID}:${input.noteID}`
}

export function createPlanBlueprintOfferFromPart(input: {
  part: Part
  sessionID: string
  workflowKind?: string
  muted: boolean
  seenKeys?: ReadonlySet<string>
}): PlanBlueprintOffer | undefined {
  if (input.workflowKind !== "plan") return undefined
  if (input.muted) return undefined

  const request = blueprintNoteWriteFocusRequest(input.part, input.sessionID)
  if (!request) return undefined

  const key = planBlueprintOfferKey({
    partID: input.part.id,
    sessionID: input.part.sessionID,
    noteID: request.noteID,
  })
  if (input.seenKeys?.has(key)) return undefined

  return {
    key,
    noteID: request.noteID,
    title: request.title?.trim() || "Blueprint",
    scopeID: request.scopeID,
  }
}

export function reducePlanBlueprintOfferState(
  state: PlanBlueprintOfferState,
  event: PlanBlueprintOfferEvent,
): PlanBlueprintOfferState {
  switch (event.type) {
    case "captured":
      if (state.muted) return state
      return { ...state, offer: event.offer }
    case "dismissed":
      if (state.offer?.key !== event.key) return state
      return { ...state, offer: null }
    case "muted":
      return { offer: null, muted: true }
    case "equipped":
      if (state.offer?.key !== event.key) return state
      return { ...state, offer: null }
    case "plan_exited":
      return emptyPlanBlueprintOfferState
  }
}

export function shouldDisplayPlanBlueprintOffer(input: {
  state: PlanBlueprintOfferState
  workflowKind?: string
  sessionStatus?: SessionStatus
  slotOccupied: boolean
  currentScopeID?: string
}): boolean {
  const offer = input.state.offer
  if (!offer) return false
  if (input.state.muted) return false
  if (input.workflowKind !== "plan") return false
  if (input.sessionStatus?.type !== "idle") return false
  if (input.slotOccupied) return false
  if (offer.scopeID && input.currentScopeID && offer.scopeID !== input.currentScopeID) return false
  return true
}
