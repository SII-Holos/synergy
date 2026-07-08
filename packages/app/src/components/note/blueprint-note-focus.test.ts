import { describe, expect, test } from "bun:test"
import type { Part } from "@ericsanchezok/synergy-sdk/client"
import { blueprintNoteWriteFocusRequest } from "./blueprint-note-focus"

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

describe("blueprintNoteWriteFocusRequest", () => {
  test("returns a focus request for completed Blueprint creates in the current session", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ action: "create", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan" })
  })

  test("returns a focus request for completed Blueprint replacements in the current session", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ action: "replace", kind: "blueprint", noteID: "note_123", title: "Plan v2" }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan v2" })
  })

  test("ignores ordinary note writes", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ action: "create", kind: "note", noteID: "note_plain", title: "Plain note" }),
        "ses_current",
      ),
    ).toBeUndefined()

    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ action: "replace", kind: "note", noteID: "note_plain", title: "Plain note" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("ignores non-deliverable Blueprint edits", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ action: "append", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toBeUndefined()

    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ tool: "note_edit", action: "edit", kind: "blueprint", noteID: "note_123", title: "Plan" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("ignores matching tool results from other sessions", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({ sessionID: "ses_other", action: "create", kind: "blueprint", noteID: "note_123" }),
        "ses_current",
      ),
    ).toBeUndefined()
  })

  test("extracts scopeID from metadata when present", () => {
    const part = toolPart({
      action: "create",
      kind: "blueprint",
      noteID: "note_123",
      title: "Plan",
    })
    ;((part as any).state.metadata as Record<string, unknown>).scopeID = "scope_abc"

    expect(blueprintNoteWriteFocusRequest(part, "ses_current")).toEqual({
      noteID: "note_123",
      title: "Plan",
      scopeID: "scope_abc",
    })
  })

  test("does not include scopeID when metadata does not carry it", () => {
    expect(
      blueprintNoteWriteFocusRequest(
        toolPart({
          action: "create",
          kind: "blueprint",
          noteID: "note_123",
          title: "Plan",
        }),
        "ses_current",
      ),
    ).toEqual({ noteID: "note_123", title: "Plan" })
  })
})
