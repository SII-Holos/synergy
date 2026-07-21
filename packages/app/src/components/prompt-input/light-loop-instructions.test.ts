import { describe, expect, test } from "bun:test"
import { buildLightLoopInstructions } from "./light-loop-instructions"

describe("Light Loop instructions", () => {
  test("requires non-empty user text", () => {
    expect(
      buildLightLoopInstructions({
        text: " ",
        uploads: [{ type: "attachment", id: "att_1", filename: "spec.pdf", mime: "application/pdf", url: "x" }],
        notes: [],
        sessions: [],
        fileAttachments: [],
        contextItems: [],
      }),
    ).toBeUndefined()
  })

  test("uses text plus compact context metadata", () => {
    const instructions = buildLightLoopInstructions({
      text: "Finish the implementation",
      uploads: [{ type: "attachment", id: "att_1", filename: "trace.log", mime: "text/plain", url: "x" }],
      notes: [{ type: "note", id: "part_note", noteId: "note_1", title: "Plan", content: "full content" }],
      sessions: [
        {
          type: "session",
          id: "part_session",
          sessionId: "ses_1",
          directory: "C:/repo",
          title: "Prior work",
        },
      ],
      fileAttachments: [
        {
          type: "file",
          path: "src/app.ts",
          content: "",
          start: 0,
          end: 0,
          selection: { startLine: 3, startChar: 0, endLine: 9, endChar: 0 },
        },
      ],
      contextItems: [{ type: "file", path: "src/context.ts" }],
    })

    expect(instructions).toContain("Finish the implementation")
    expect(instructions).toContain("File: src/app.ts lines 3-9")
    expect(instructions).toContain("Context file: src/context.ts")
    expect(instructions).toContain("Attachment: trace.log (text/plain)")
    expect(instructions).toContain("Note: Plan (note_1)")
    expect(instructions).toContain("Session: Prior work (ses_1, C:/repo)")
    expect(instructions).not.toContain("full content")
  })
})
