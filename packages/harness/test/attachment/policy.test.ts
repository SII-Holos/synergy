import { describe, expect, test } from "bun:test"
import { Attachment } from "../../src/attachment"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("Attachment.policy", () => {
  test("keeps image attachments and saves locally", () =>
    runtime.run(() => {
      expect(Attachment.policy({ filename: "photo.png", mime: "image/png" })).toMatchObject({
        kind: "image",
        extractText: false,
        keepBinary: true,
        saveLocal: true,
      })
    }))

  test("keeps PDF binary without requesting an unavailable text processor", () =>
    runtime.run(() => {
      expect(Attachment.policy({ filename: "report.pdf" })).toMatchObject({
        kind: "pdf",
        extractText: false,
        keepBinary: true,
        saveLocal: false,
      })
    }))
  test("keeps arbitrary files as-is without a second media copy", () =>
    runtime.run(() => {
      expect(Attachment.policy({ filename: "setup.exe", mime: "application/x-msdownload" })).toMatchObject({
        kind: "other",
        extractText: false,
        keepBinary: false,
        saveLocal: false,
        model: { mode: "summary" },
      })
      expect(Attachment.policy({ filename: "payload.bin" })).toMatchObject({
        kind: "other",
        extractText: false,
        keepBinary: false,
        saveLocal: false,
        model: { mode: "summary" },
      })
    }))
})

test("missing document processor does not advertise extraction", () =>
  runtime.run(async () => {
    expect(Attachment.policy({ filename: "slides.pptx" }).extractText).toBe(false)
    await expect(Attachment.extractTextFromFile("slides.pptx")).rejects.toThrow("no processor is registered")
  }))

afterRuntimeTests(() => runtime.close())
