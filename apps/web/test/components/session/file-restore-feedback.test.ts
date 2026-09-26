import { expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { fileRestoreFeedback } from "../../../src/components/session/file-restore-feedback"
const i18n = setupI18n({ locale: "en", messages: { en: {} } })

test("partial file restoration is an error with accurate counts and file-specific reasons", () => {
  const feedback = fileRestoreFeedback(
    {
      restoredFiles: ["/a.txt"],
      failedFiles: [{ file: "/b.txt", code: "conflict", message: "File changed" }],
      patchPartIDs: [],
    },
    i18n,
  )
  expect(feedback.type).toBe("error")
  expect(feedback.description).toContain("1 file restored")
  expect(feedback.description).toContain("1 file could not be restored")
  expect(feedback.description).toContain("/b.txt: File changed")
})

test("missing restoration responses never display success", () => {
  expect(() => fileRestoreFeedback(undefined, i18n)).toThrow()
})
