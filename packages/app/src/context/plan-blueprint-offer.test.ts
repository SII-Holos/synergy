import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import {
  blueprintNoteCreateFocusRequest,
  createPlanBlueprintOfferFromPart,
  emptyPlanBlueprintOfferState,
  findLatestPlanBlueprintOfferFromParts,
  reducePlanBlueprintOfferState,
  shouldDisplayPlanBlueprintOffer,
} from "./plan-blueprint-offer"

function toolPart(input: {
  sessionID?: string
  messageID?: string
  partID?: string
  tool?: string
  status?: string
  action?: string
  kind?: string
  noteID?: string
  title?: string
  mode?: string
  scopeID?: string
}): Part {
  return {
    id: input.partID ?? "part_1",
    sessionID: input.sessionID ?? "ses_current",
    messageID: input.messageID ?? "msg_1",
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
        scopeID: input.scopeID,
      },
      time: { start: 1, end: 2 },
    },
  } as Part
}

function message(id: string): Pick<Message, "id"> {
  return { id }
}

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy", description: "working" }

describe("blueprintNoteCreateFocusRequest", () => {
  test("returns a focus request only for completed Blueprint creates in the target session", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "create", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan" })

    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "replace", kind: "blueprint", noteID: "note_123", title: "Plan v2" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("ignores ordinary notes, non-deliverable edits, and other sessions", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "create", kind: "note", noteID: "note_plain", title: "Plain note" }),
        "ses_current",
      ),
    ).toBeUndefined()

    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "append", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toBeUndefined()

    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ tool: "note_edit", action: "edit", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toBeUndefined()

    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ sessionID: "ses_other", action: "create", kind: "blueprint", noteID: "note_123" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("extracts optional scopeID from metadata", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "create", kind: "blueprint", noteID: "note_123", title: "Plan", scopeID: "scope_abc" }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan", scopeID: "scope_abc" })
  })
})

describe("plan blueprint offer model", () => {
  test("captures completed Blueprint writes for the owning Plan session", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({
        sessionID: "ses_background",
        action: "create",
        kind: "blueprint",
        noteID: "note_123",
        title: "Implementation plan",
      }),
      sessionID: "ses_background",
      workflowKind: "plan",
    })

    expect(offer).toEqual({
      key: "ses_background:part_1:note_123",
      noteID: "note_123",
      title: "Implementation plan",
      runCount: 0,
    })
  })

  test("ignores non-Plan sessions, ordinary notes, and non-deliverable Blueprint writes", () => {
    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "lightloop",
      }),
    ).toBeUndefined()

    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "replace", kind: "note", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "plan",
      }),
    ).toBeUndefined()

    expect(
      createPlanBlueprintOfferFromPart({
        part: toolPart({ action: "append", kind: "blueprint", noteID: "note_123" }),
        sessionID: "ses_current",
        workflowKind: "plan",
      }),
    ).toBeUndefined()
  })

  test("keeps a captured offer hidden until the owning session is idle", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
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

  test("dismiss, mute, equip, and Plan exit preserve seen keys", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
    })!
    const captured = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer })

    expect(captured.seenKeys).toEqual([offer.key])
    expect(reducePlanBlueprintOfferState(captured, { type: "dismissed", key: offer.key })).toEqual({
      offer: null,
      muted: false,
      seenKeys: [offer.key],
    })
    expect(reducePlanBlueprintOfferState(captured, { type: "equipped", key: offer.key })).toEqual({
      offer: null,
      muted: false,
      seenKeys: [offer.key],
    })
    expect(reducePlanBlueprintOfferState(captured, { type: "muted" })).toEqual({
      offer: null,
      muted: true,
      seenKeys: [offer.key],
    })
    expect(reducePlanBlueprintOfferState(captured, { type: "plan_exited" })).toEqual({
      offer: null,
      muted: false,
      seenKeys: [offer.key],
    })
  })

  test("clears the complete offer state when the owning session is removed", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
    })!
    const captured = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer })

    expect(reducePlanBlueprintOfferState(captured, { type: "session_removed" })).toEqual(emptyPlanBlueprintOfferState)
  })

  test("does not re-offer historical Blueprint parts after Plan re-entry", () => {
    const oldPart = toolPart({
      messageID: "msg_1",
      partID: "part_old",
      action: "create",
      kind: "blueprint",
      noteID: "note_old",
      title: "Old plan",
    })
    const oldOffer = createPlanBlueprintOfferFromPart({
      part: oldPart,
      sessionID: "ses_current",
      workflowKind: "plan",
    })!
    const captured = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer: oldOffer })
    const equipped = reducePlanBlueprintOfferState(captured, { type: "equipped", key: oldOffer.key })
    const exited = reducePlanBlueprintOfferState(equipped, { type: "plan_exited" })

    expect(
      findLatestPlanBlueprintOfferFromParts({
        messages: [message("msg_1")],
        partsByMessage: { msg_1: [oldPart] },
        sessionID: "ses_current",
        workflowKind: "plan",
        state: exited,
      }),
    ).toBeUndefined()

    const newPart = toolPart({
      messageID: "msg_1",
      partID: "part_new",
      action: "create",
      kind: "blueprint",
      noteID: "note_new",
      title: "New plan",
    })
    const newOffer = createPlanBlueprintOfferFromPart({
      part: newPart,
      sessionID: "ses_current",
      workflowKind: "plan",
    })!

    expect(
      findLatestPlanBlueprintOfferFromParts({
        messages: [message("msg_1")],
        partsByMessage: { msg_1: [oldPart, newPart] },
        sessionID: "ses_current",
        workflowKind: "plan",
        state: exited,
      }),
    ).toEqual(newOffer)
  })

  test("does not display a captured offer when the Blueprint slot is occupied", () => {
    const offer = createPlanBlueprintOfferFromPart({
      part: toolPart({ action: "create", kind: "blueprint", noteID: "note_123" }),
      sessionID: "ses_current",
      workflowKind: "plan",
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

  test("backfills only the latest unseen Blueprint offer from loaded message parts", () => {
    const latestPart = toolPart({
      messageID: "msg_2",
      partID: "part_2",
      action: "replace",
      kind: "blueprint",
      noteID: "note_latest",
      title: "Latest plan",
    })
    const latest = createPlanBlueprintOfferFromPart({
      part: latestPart,
      sessionID: "ses_current",
      workflowKind: "plan",
    })!

    expect(
      findLatestPlanBlueprintOfferFromParts({
        messages: [message("msg_1"), message("msg_2")],
        partsByMessage: {
          msg_1: [toolPart({ messageID: "msg_1", action: "create", kind: "blueprint", noteID: "note_old" })],
          msg_2: [latestPart],
        },
        sessionID: "ses_current",
        workflowKind: "plan",
        state: emptyPlanBlueprintOfferState,
      }),
    ).toEqual(latest)

    const seen = reducePlanBlueprintOfferState(emptyPlanBlueprintOfferState, { type: "captured", offer: latest })
    expect(
      findLatestPlanBlueprintOfferFromParts({
        messages: [message("msg_1"), message("msg_2")],
        partsByMessage: {
          msg_1: [toolPart({ messageID: "msg_1", action: "create", kind: "blueprint", noteID: "note_old" })],
          msg_2: [latestPart],
        },
        sessionID: "ses_current",
        workflowKind: "plan",
        state: seen,
      }),
    ).toBeUndefined()
  })
})
