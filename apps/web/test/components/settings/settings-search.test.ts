import { expect, test } from "bun:test"
import { BUILTIN_SETTINGS_SECTIONS } from "../../../src/components/settings/catalog"
import { settingsSearchResults } from "../../../src/components/settings/settings-search"

test("font searches return distinct fields in General", () => {
  const results = settingsSearchResults(BUILTIN_SETTINGS_SECTIONS, "font")
  expect(results.flatMap((result) => result.fields)).toEqual(["Interface font", "Monospace font"])
  expect(results.map((result) => result.section.id)).toEqual(["general"])
})

test("section aliases remain searchable without manufacturing a field hit", () => {
  const results = settingsSearchResults(BUILTIN_SETTINGS_SECTIONS, "light")
  expect(results.find((result) => result.section.id === "general")?.fields).toEqual([])
  expect(settingsSearchResults(BUILTIN_SETTINGS_SECTIONS, "zznonexistentzz")).toEqual([])
})

test("localized row labels match all query words", () => {
  const sections = [{ id: "general", label: "通用", rowLabels: ["界面字体", "等宽字体"] }]
  expect(settingsSearchResults(sections, "界面 字体")[0]?.fields).toEqual(["界面字体"])
})
