import { describe, expect, test } from "bun:test"
import type { Part } from "@ericsanchezok/synergy-sdk/client"
import { blueprintNoteCreateFocusRequest } from "./blueprint-note-focus"

function toolPart(input: {
  sessionID?: string
  tool?: string
  status?: string
  action?: string
  kind?: string
  noteID?: string
  title?: string
  mode?: string
}): Part {
  return {
    id: "part_1",
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

describe("blueprintNoteCreateFocusRequest", () => {
  test("returns a focus request for completed Blueprint creates in the current session", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "create", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan" })
  })

  test("ignores ordinary note writes", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "create", kind: "note", noteID: "note_plain", title: "Plain note" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("ignores non-create Blueprint edits", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ action: "replace", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("ignores matching tool results from other sessions", () => {
    expect(
      blueprintNoteCreateFocusRequest(
        toolPart({ sessionID: "ses_other", action: "create", kind: "blueprint", noteID: "note_123" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })
})
