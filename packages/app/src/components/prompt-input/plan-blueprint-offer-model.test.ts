import { describe, expect, test } from "bun:test"
import type { Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import {
  createPlanBlueprintOfferFromPart,
  emptyPlanBlueprintOfferState,
  reducePlanBlueprintOfferState,
  shouldDisplayPlanBlueprintOffer,
} from "./plan-blueprint-offer-model"

function toolPart(input: {
  sessionID?: string
  partID?: string
  tool?: string
  status?: string
  action?: string
  kind?: string
  noteID?: string
  title?: string
  mode?: string
}): Part {
  return {
    id: input.partID ?? "part_1",
    sessionID: input.sessionID ?? "ses_current",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: input.tool ?? "note_write",
    state: {
      status: input.status ?? "completed",
      input: {
        mode: input.mode,
        kind: input.kind,
        title: input.title,
      },
      output: "",
      title: input.title ?? "Created Blueprint",
      metadata: {
        id: input.noteID,
        action: input.action,
        kind: input.kind,
        title: input.title,
      },
      time: { start: 1, end: 2 },
    },
  } as Part
}

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy", description: "working" }

describe("plan blueprint offer model", () => {
  test("captures completed Blueprint creates while the current session is in Plan", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123", title: "Implementation plan" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: false,
    })

    expect(offer).toEqual({
      key: "ses_current:part_1:note_123",
      noteID: "note_123",
      title: "Implementation plan",
    })
  })

  test("captures completed Blueprint replacements while the current session is in Plan", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "replace", kind: "blueprint", noteID: "note_123", title: "Implementation plan v2" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: false,
    })

    expect(offer).toEqual({
      key: "ses_current:part_1:note_123",
      noteID: "note_123",
      title: "Implementation plan v2",
    })
  })

  test("ignores non-Plan sessions, ordinary notes, and non-deliverable Blueprint writes", () => {
    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "lightloop",
        muted: false,
      }),
    ).toBeUndefined()

    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "replace", kind: "blueprint", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "lightloop",
        muted: false,
      }),
    ).toBeUndefined()

    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "replace", kind: "note", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "plan",
        muted: false,
      }),
    ).toBeUndefined()

    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "append", kind: "blueprint", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "plan",
        muted: false,
      }),
    ).toBeUndefined()
  })

  test("keeps a captured offer hidden until the session turn is idle", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: false,
    })!
    const state = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer })

    expect(
      shouldDisplayPlanBlueprintOffer({
        state,
        workflowKind: "plan",
        sessionStatus: busy,
        slotOccupied: false,
      }),
    ).toBe(false)

    expect(
      shouldDisplayPlanBlueprintOffer({
        state,
        workflowKind: "plan",
        sessionStatus: idle,
        slotOccupied: false,
      }),
    ).toBe(true)
  })

  test("dismiss hides only the current offer", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: false,
    })!
    const captured = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer })
    const dismissed = reducePlanBlueprintOfferState(captured, { type: "dismissed", key: offer.key })

    expect(dismissed).toEqual({ offer: null, muted: false })
  })

  test("mute suppresses later offers until Plan exits", () => {
    const muted = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "muted" })
    expect(muted).toEqual({ offer: null, muted: true })

    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: muted.muted,
    })
    expect(offer).toBeUndefined()

    expect(reducePlanBlueprintOfferState(muted, { type: "plan_exited" })).toEqual(emptyPlanBlueprintOfferState)
  })

  test("does not display a captured offer when the Blueprint slot is occupied", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
      muted: false,
    })!
    const state = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer })

    expect(
      shouldDisplayPlanBlueprintOffer({
        state,
        workflowKind: "plan",
        sessionStatus: idle,
        slotOccupied: true,
      }),
    ).toBe(false)
  })
})
