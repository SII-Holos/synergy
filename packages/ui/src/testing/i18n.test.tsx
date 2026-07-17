import { describe, expect, test } from "bun:test"

// RED test — i18n.tsx does not exist yet
import { setupI18n } from "./i18n"

describe("setupI18n (UI test helper)", () => {
  test("returns an I18n instance", () => {
    const i18n = setupI18n()
    expect(i18n.locale).toBe("en")
  })

  test("allows activating a locale", () => {
    const i18n = setupI18n()
    i18n.loadAndActivate({ locale: "en", messages: {} })
    expect(i18n.locale).toBe("en")
  })

  test("translates with _()", () => {
    const i18n = setupI18n()
    const id = "test.hello"
    i18n.loadAndActivate({
      locale: "en",
      messages: { [id]: "Hello" },
    })
    expect(i18n._(id)).toBe("Hello")
  })

  test("translates with _() descriptor", () => {
    const i18n = setupI18n()
    i18n.loadAndActivate({
      locale: "en",
      messages: { "test.world": "World" },
    })
    expect(i18n._({ id: "test.world" })).toBe("World")
  })

  test("falls back to id when message is missing", () => {
    const i18n = setupI18n()
    i18n.loadAndActivate({ locale: "en", messages: {} })
    expect(i18n._("missing.key")).toBe("missing.key")
  })
})
