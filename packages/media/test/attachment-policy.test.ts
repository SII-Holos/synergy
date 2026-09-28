import { expect, test } from "bun:test"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"
import { registerDocumentExtraction } from "../src/register-documents"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

test("audio remains a binary attachment even when the document converter recognizes its extension", () =>
  runtime.run(() => {
    for (const [filename, mime] of [
      ["sound.wav", "audio/wav"],
      ["sound.mp3", "audio/mpeg"],
    ]) {
      expect(Attachment.policy({ filename, mime })).toMatchObject({
        kind: "media",
        extractText: false,
        keepBinary: true,
      })
    }
  }))

test("extracts text from office docs without keeping binary", () =>
  runtime.run(() => {
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
  }))

test("registered processor extracts PDF text and retains the original binary", () =>
  runtime.run(() => {
    expect(Attachment.policy({ filename: "report.pdf" })).toMatchObject({
      kind: "pdf",
      extractText: true,
      keepBinary: true,
    })
  }))

afterRuntimeTests(() => runtime.close())
