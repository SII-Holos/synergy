import { describe, expect, test } from "bun:test"
import {
  attachmentColumnCount,
  attachmentColumns,
  attachmentKind,
  formatAttachmentSize,
  resolveAttachmentUrl,
  type AttachmentFile,
} from "../src/components/attachment-card-utils"

describe("attachment card helpers", () => {
  test("resolves safe attachment URLs", () => {
    const serverUrl = "http://localhost:3000/"

    expect(resolveAttachmentUrl(serverUrl, file({ url: "asset://abc123.png" }))).toBe(
      "http://localhost:3000/asset/abc123.png",
    )
    expect(resolveAttachmentUrl(serverUrl, file({ assetId: "def456.pdf" }))).toBe(
      "http://localhost:3000/asset/def456.pdf",
    )
    expect(resolveAttachmentUrl(serverUrl, file({ url: "data:image/png;base64,AAA" }))).toBe(
      "data:image/png;base64,AAA",
    )
    expect(resolveAttachmentUrl(serverUrl, file({ url: "https://example.com/report.pdf" }))).toBe(
      "https://example.com/report.pdf",
    )
    expect(resolveAttachmentUrl(serverUrl, file({ url: "file:///tmp/secret.png" }))).toBeUndefined()
  })

  test("labels common attachment kinds and sizes", () => {
    expect(attachmentKind(file({ mime: "application/pdf" }))).toBe("PDF")
    expect(attachmentKind(file({ mime: "text/csv" }))).toBe("CSV")
    expect(attachmentKind(file({ mime: "image/webp" }))).toBe("WEBP")
    expect(
      attachmentKind(file({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
    ).toBe("DOCX")
    expect(formatAttachmentSize(12)).toBe("12 B")
    expect(formatAttachmentSize(1536)).toBe("1.5 KB")
  })

  test("uses compact gallery columns", () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ filename: `file-${i}.png` }))

    expect(attachmentColumnCount([])).toBe(0)
    expect(attachmentColumnCount(files.slice(0, 1))).toBe(1)
    expect(attachmentColumnCount(files.slice(0, 2))).toBe(2)
    expect(attachmentColumnCount(files)).toBe(3)
    expect(attachmentColumns(files).map((column) => column.length)).toEqual([2, 2, 1])
  })
})

function file(input: Partial<AttachmentFile>): AttachmentFile {
  return {
    mime: "image/png",
    ...input,
  }
}
