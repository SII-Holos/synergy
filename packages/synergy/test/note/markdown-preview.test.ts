import { describe, expect, test } from "bun:test"
import { NoteMarkdown } from "../../src/note/markdown"

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

function tableCell(type: "tableHeader" | "tableCell", text: string) {
  return { type, content: [paragraph(text)] }
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

  test("renders rich safe preview structures", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Read " },
            { type: "text", text: "source", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
            { type: "text", text: " for " },
            { type: "inlineMath", attrs: { latex: "x^2", display: "no" } },
          ],
        },
        { type: "image", attrs: { src: "/asset/local-image", alt: "Architecture diagram" } },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [tableCell("tableHeader", "Dimension"), tableCell("tableHeader", "Result")] },
            { type: "tableRow", content: [tableCell("tableCell", "256d"), tableCell("tableCell", "-1%")] },
          ],
        },
        { type: "mermaid", attrs: { content: "graph TD\n  A --> B" } },
        { type: "video", attrs: { src: "/asset/demo-video" } },
      ],
    }

    const html = NoteMarkdown.toPreviewHtml(content)

    expect(html).toContain('class="note-preview-link"')
    expect(html).toContain('class="note-preview-math"')
    expect(html).toContain('src="/asset/local-image"')
    expect(html).toContain("<table>")
    expect(html).toContain("Dimension")
    expect(html).toContain("note-preview-diagram")
    expect(html).toContain("Video")
  })

  test("does not load untrusted external preview images", () => {
    const content = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.com/image.png", alt: "External image" } }],
    }

    const html = NoteMarkdown.toPreviewHtml(content)

    expect(html).toContain("Image")
    expect(html).toContain("External image")
    expect(html).not.toContain("https://example.com/image.png")
    expect(html).not.toContain("<img")
  })
})
