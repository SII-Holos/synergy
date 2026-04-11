import { describe, expect, test } from "bun:test"
import { Attachment } from "../../src/attachment"

describe("Attachment.policy", () => {
  test("keeps image attachments and saves locally", () => {
    expect(Attachment.policy({ filename: "photo.png", mime: "image/png" })).toEqual({
      kind: "image",
      extractText: false,
      keepBinary: true,
      saveLocal: true,
    })
  })

  test("extracts text from office docs without keeping binary", () => {
    expect(Attachment.policy({ filename: "slides.pptx" })).toEqual({
      kind: "document",
      extractText: true,
      keepBinary: false,
      saveLocal: false,
    })
    expect(Attachment.policy({ filename: "sheet.xlsx" })).toEqual({
      kind: "document",
      extractText: true,
      keepBinary: false,
      saveLocal: false,
    })
    expect(Attachment.policy({ filename: "report.docx" })).toEqual({
      kind: "document",
      extractText: true,
      keepBinary: false,
      saveLocal: false,
    })
  })

  test("extracts text from pdf and keeps binary", () => {
    expect(Attachment.policy({ filename: "report.pdf" })).toEqual({
      kind: "pdf",
      extractText: true,
      keepBinary: true,
      saveLocal: false,
    })
  })
})
