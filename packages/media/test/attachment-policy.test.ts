import { expect, test } from "bun:test"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"
import { registerDocumentExtraction } from "../src/register-documents"
registerDocumentExtraction()
test("extracts text from office docs without keeping binary", () => {
  expect(Attachment.policy({ filename: "slides.pptx" })).toMatchObject({
    kind: "document",
    extractText: true,
    keepBinary: false,
    saveLocal: false,
  })
  expect(Attachment.policy({ filename: "sheet.xlsx" })).toMatchObject({
    kind: "document",
    extractText: true,
    keepBinary: false,
    saveLocal: false,
  })
  expect(Attachment.policy({ filename: "report.docx" })).toMatchObject({
    kind: "document",
    extractText: true,
    keepBinary: false,
    saveLocal: false,
  })
})

test("registered processor extracts PDF text and retains the original binary", () => {
  expect(Attachment.policy({ filename: "report.pdf" })).toMatchObject({
    kind: "pdf",
    extractText: true,
    keepBinary: true,
  })
})
