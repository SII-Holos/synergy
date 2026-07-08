import { describe, expect, test } from "bun:test"
import { getNoteSnapshotDelta } from "./note-snapshot"

const content = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Keep my scroll position" }],
    },
  ],
}

describe("getNoteSnapshotDelta", () => {
  test("treats metadata-only note updates as stable editor content", () => {
    expect(
      getNoteSnapshotDelta(
        {
          title: "Blueprint",
          tags: ["draft"],
          content,
        },
        {
          title: "Blueprint",
          tags: ["draft"],
          content: structuredClone(content),
        },
      ),
    ).toEqual({
      contentChanged: false,
      tagsChanged: false,
      titleChanged: false,
    })
  })

  test("detects title and tag changes without forcing an editor content reset", () => {
    expect(
      getNoteSnapshotDelta(
        {
          title: "Blueprint",
          tags: ["draft"],
          content,
        },
        {
          title: "Renamed Blueprint",
          tags: ["draft", "active"],
          content,
        },
      ),
    ).toEqual({
      contentChanged: false,
      tagsChanged: true,
      titleChanged: true,
    })
  })

  test("detects remote document content changes", () => {
    expect(
      getNoteSnapshotDelta(
        {
          title: "Blueprint",
          tags: [],
          content,
        },
        {
          title: "Blueprint",
          tags: [],
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Remote edit" }],
              },
            ],
          },
        },
      ).contentChanged,
    ).toBe(true)
  })
})
