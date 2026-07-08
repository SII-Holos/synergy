import type { Message, Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"

export interface BlueprintNoteFocusRequest {
  noteID: string
  title?: string
  scopeID?: string
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function blueprintNoteWriteFocusRequest(part: Part, sessionID: string): BlueprintNoteFocusRequest | undefined {
  if (part.sessionID !== sessionID) return undefined
  if (part.type !== "tool") return undefined
  if (part.tool !== "note_write") return undefined
  if (part.state.status !== "completed") return undefined

  const metadata = part.state.metadata ?? {}
  const input = part.state.input ?? {}
  const action = stringValue(metadata.action) ?? stringValue(input.mode) ?? "create"
  if (action !== "create" && action !== "replace") return undefined

  const kind = stringValue(metadata.kind) ?? stringValue(input.kind)
  if (kind !== "blueprint") return undefined

  const noteID = stringValue(metadata.id)
  if (!noteID) return undefined

  return {
    noteID,
    title: stringValue(metadata.title) ?? stringValue(input.title),
    scopeID: stringValue(metadata.scopeID),
  }
}

export type PlanBlueprintOffer = {
  key: string
  noteID: string
  title: string
  scopeID?: string
}

export type PlanBlueprintOfferState = {
  offer: PlanBlueprintOffer | null
  muted: boolean
  seenKeys: string[]
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
  seenKeys: [],
}

export function isEmptyPlanBlueprintOfferState(state: PlanBlueprintOfferState): boolean {
  return !state.offer && !state.muted && state.seenKeys.length === 0
}

export function planBlueprintOfferKey(input: { partID: string; sessionID: string; noteID: string }) {
  return `${input.sessionID}:${input.partID}:${input.noteID}`
}

export function createPlanBlueprintOfferFromPart(input: {
  part: Part
  sessionID: string
  workflowKind?: string
}): PlanBlueprintOffer | undefined {
  if (input.workflowKind !== "plan") return undefined

  const request = blueprintNoteWriteFocusRequest(input.part, input.sessionID)
  if (!request) return undefined

  return {
    key: planBlueprintOfferKey({
      partID: input.part.id,
      sessionID: input.part.sessionID,
      noteID: request.noteID,
    }),
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
      if (state.seenKeys.includes(event.offer.key)) return state
      return { ...state, offer: event.offer, seenKeys: [...state.seenKeys, event.offer.key] }
    case "dismissed":
      if (state.offer?.key !== event.key) return state
      return { ...state, offer: null }
    case "muted":
      return { ...state, offer: null, muted: true }
    case "equipped":
      if (state.offer?.key !== event.key) return state
      return { ...state, offer: null }
    case "plan_exited":
      return emptyPlanBlueprintOfferState
  }
}

export function findLatestPlanBlueprintOfferFromParts(input: {
  messages: Pick<Message, "id">[]
  partsByMessage: Record<string, Part[]>
  sessionID: string
  workflowKind?: string
  state: PlanBlueprintOfferState
}): PlanBlueprintOffer | undefined {
  if (input.workflowKind !== "plan") return undefined
  if (input.state.muted) return undefined

  for (let messageIndex = input.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = input.messages[messageIndex]
    if (!message) continue

    const parts = input.partsByMessage[message.id] ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (!part) continue

      const offer = createPlanBlueprintOfferFromPart({
        part,
        sessionID: input.sessionID,
        workflowKind: input.workflowKind,
      })
      if (!offer) continue
      return input.state.seenKeys.includes(offer.key) ? undefined : offer
    }
  }

  return undefined
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
