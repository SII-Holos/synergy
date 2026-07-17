import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { changedCatalogPaths, missingTranslationIds } from "./i18n-check"

describe("i18n catalog drift check", () => {
  test("reports changed, added, and removed catalogs in stable order", () => {
    const before = new Map([
      ["zh-CN/messages.po", "old translation"],
      ["en/messages.po", "source"],
      ["obsolete/messages.po", "obsolete"],
    ])
    const after = new Map([
      ["en/messages.po", "updated source"],
      ["zh-CN/messages.po", "old translation"],
      ["new/messages.po", "new"],
    ])

    expect(changedCatalogPaths(before, after)).toEqual(["en/messages.po", "new/messages.po", "obsolete/messages.po"])
  })

  test("accepts deterministic extraction output", () => {
    const catalogs = new Map([
      ["en/messages.po", "source"],
      ["zh-CN/messages.po", "translation"],
    ])

    expect(changedCatalogPaths(catalogs, new Map(catalogs))).toEqual([])
  })
})

describe("i18n translation completeness", () => {
  test("reports missing and blank translations while ignoring the PO header", () => {
    const source = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"

msgid "app.complete"
msgstr "Complete"

msgid "app.blank"
msgstr "Blank"

msgid "app.missing"
msgstr "Missing"
`
    const target = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"

msgid "app.complete"
msgstr "完整"

msgid "app.blank"
msgstr ""
`

    expect(missingTranslationIds(source, target)).toEqual(["app.blank", "app.missing"])
  })

  test("keeps the English source catalog complete", async () => {
    const source = await readFile(new URL("../src/locales/en/messages.po", import.meta.url), "utf-8")

    expect(missingTranslationIds(source, source)).toEqual([])
  })
})
