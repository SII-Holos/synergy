import { expect, test } from "bun:test"
import { classifyResourcePreview } from "../../src/components/resource-preview"

test("workspace files and immutable assets share format capabilities", () => {
  for (const [filename, mime] of [
    ["report.pdf", "application/pdf"],
    ["notes.md", "text/markdown"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["clip.mp4", "video/mp4"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ]) {
    expect(classifyResourcePreview(mime, filename)).toEqual(
      classifyResourcePreview(mime, filename, filename.endsWith("md") ? "text" : "binary"),
    )
  }
  expect(classifyResourcePreview("", "photo.png", "image").kind).toBe("image")
  expect(classifyResourcePreview("application/octet-stream", "data.ts", "binary").kind).toBe("unsupported")
})
