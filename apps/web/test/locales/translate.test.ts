import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { translateDescriptor } from "../../src/locales/translate"

describe("translateDescriptor", () => {
  test("translates through a Lingui object without losing its receiver", () => {
    const i18n = setupI18n({ locale: "en" })
    const descriptor = { id: "test.translateDescriptor.label", message: "Translated label" }
    i18n.loadAndActivate({ locale: "en", messages: { [descriptor.id]: descriptor.message } })

    expect(translateDescriptor(descriptor, i18n)).toBe("Translated label")
  })
})
