import { describe, expect, test } from "bun:test"
import { NoteMarkdown } from "../../src/note/markdown"

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

describe("NoteMarkdown.toPreviewHtml", () => {
  test("includes enough short blocks to fill note card previews", () => {
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Faro" }] },
        ...Array.from({ length: 12 }, (_, i) => paragraph(`Preview block ${i + 1}`)),
      ],
    }

    const html = NoteMarkdown.toPreviewHtml(content, { title: "Faro" })

    expect(html).not.toContain("Faro")
    expect(html).toContain("Preview block 10")
  })

  test("respects explicit maxBlocks", () => {
    const content = {
      type: "doc",
      content: [paragraph("Preview block 1"), paragraph("Preview block 2"), paragraph("Preview block 3")],
    }

    const html = NoteMarkdown.toPreviewHtml(content, { maxBlocks: 2 })

    expect(html).toContain("Preview block 2")
    expect(html).not.toContain("Preview block 3")
  })
})
