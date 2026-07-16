import { describe, expect, test } from "bun:test"
import { setupI18n as coreSetupI18n } from "@lingui/core"
import { i18n as globalI18n } from "@lingui/core"
import { applyDocumentLanguage } from "./document-language"

// Seed message: this ID will be extracted by lingui extract.
const SEED_ID = "app.loading.label"
const SEED_MESSAGE = "Loading..."

describe("locale runtime provider", () => {
  test("seed message is defined as a constant", () => {
    expect(SEED_ID).toBe("app.loading.label")
    expect(SEED_MESSAGE).toBe("Loading...")
  })

  test("global i18n instance exists", () => {
    // Global singleton exists from @lingui/core
    expect(typeof globalI18n._).toBe("function")
  })

  test("setupI18n creates a fresh instance", () => {
    const i18n = coreSetupI18n({ locale: "en" })
    expect(i18n.locale).toBe("en")
  })

  test("i18n._(descriptor) resolves with explicit ID", () => {
    const i18n = coreSetupI18n({ locale: "en" })
    i18n.loadAndActivate({
      locale: "en",
      messages: { [SEED_ID]: "Loading test" },
    })
    expect(i18n._({ id: SEED_ID, message: SEED_MESSAGE })).toBe("Loading test")
  })

  test("applies the active locale to the document root", () => {
    const root = { lang: "en" }

    applyDocumentLanguage(root, "zh-CN")

    expect(root.lang).toBe("zh-CN")
  })

  test("active locale is reflected", () => {
    const i18n = coreSetupI18n({ locale: "en" })
    i18n.loadAndActivate({
      locale: "en",
      messages: {},
    })
    expect(i18n.locale).toBe("en")
  })
})
