import { describe, expect, test } from "bun:test"
import { setupI18n as coreSetupI18n } from "@lingui/core"
import { i18n as globalI18n } from "@lingui/core"
import { applyDocumentLanguage } from "../../../src/context/locale/document-language"
import { createReactiveI18n } from "../../../src/context/locale/reactive-i18n"

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

  test("locale-context translations read the reactive generation", () => {
    const i18n = coreSetupI18n({ locale: "en" })
    i18n.loadAndActivate({ locale: "en", messages: { [SEED_ID]: "Loading test" } })
    let reads = 0
    const reactiveI18n = createReactiveI18n(i18n, () => {
      reads += 1
      return reads
    })

    expect(reactiveI18n._({ id: SEED_ID, message: SEED_MESSAGE })).toBe("Loading test")
    expect(reads).toBe(1)
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
