import { describe, expect, test } from "bun:test"
import { buildLightLoopTaskDescription } from "./light-loop-task"

describe("Light Loop task description", () => {
  test("requires non-empty user text", () => {
    expect(
      buildLightLoopTaskDescription({
        text: " ",
        uploads: [{ type: "attachment", id: "att_1", filename: "spec.pdf", mime: "application/pdf", url: "x" }],
        notes: [],
        sessions: [],
        fileAttachments: [],
        contextItems: [],
        activeTabIncluded: false,
      }),
    ).toBeUndefined()
  })

  test("uses text plus compact context metadata", () => {
    const task = buildLightLoopTaskDescription({
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
      activeFile: "src/active.ts",
      activeTabIncluded: true,
    })

    expect(task).toContain("Finish the implementation")
    expect(task).toContain("File: src/app.ts lines 3-9")
    expect(task).toContain("Active file: src/active.ts")
    expect(task).toContain("Context file: src/context.ts")
    expect(task).toContain("Attachment: trace.log (text/plain)")
    expect(task).toContain("Note: Plan (note_1)")
    expect(task).toContain("Session: Prior work (ses_1, C:/repo)")
    expect(task).not.toContain("full content")
  })
})
