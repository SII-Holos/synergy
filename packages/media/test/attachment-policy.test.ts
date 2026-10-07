import { expect, test } from "bun:test"
import { Attachment } from "@ericsanchezok/synergy-harness/attachment"
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
        model: { mode: "summary" },
      })
    }
  }))

test("office documents use extracted text and model summaries", () =>
  runtime.run(() => {
    expect(Attachment.policy({ filename: "slides.pptx" })).toMatchObject({
      kind: "document",
      extractText: true,
      model: { mode: "summary" },
    })
    expect(Attachment.policy({ filename: "sheet.xlsx" })).toMatchObject({
      kind: "document",
      extractText: true,
      model: { mode: "summary" },
    })
    expect(Attachment.policy({ filename: "report.docx" })).toMatchObject({
      kind: "document",
      extractText: true,
      model: { mode: "summary" },
    })
  }))

test("registered processor extracts PDF text and retains the original binary", () =>
  runtime.run(() => {
    expect(Attachment.policy({ filename: "report.pdf" })).toMatchObject({
      kind: "pdf",
      extractText: true,
      model: { mode: "summary" },
    })
  }))

afterRuntimeTests(() => runtime.close())
