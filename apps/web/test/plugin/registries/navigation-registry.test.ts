import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { navigationEntryLabel, type NavigationEntry } from "../../../src/plugin/registries/navigation-registry"

function entry(input: Pick<NavigationEntry, "label" | "labelDescriptor">): NavigationEntry {
  return {
    id: "test",
    navigationId: "test",
    placement: "sidebar",
    path: "/test",
    ...input,
  }
}

describe("navigation entry labels", () => {
  test("re-resolves built-in descriptors while preserving plugin-author labels", () => {
    const descriptor = { id: "app.plugin.builtin.test", message: "Built in" }
    const i18n = setupI18n({ locale: "en" })
    i18n.loadAndActivate({ locale: "en", messages: { [descriptor.id]: descriptor.message } })

    const builtIn = entry({ label: descriptor.id, labelDescriptor: descriptor })
    const plugin = entry({ label: "Author label" })
    expect(navigationEntryLabel(builtIn, i18n._.bind(i18n))).toBe("Built in")
    expect(navigationEntryLabel(plugin, i18n._.bind(i18n))).toBe("Author label")

    i18n.loadAndActivate({ locale: "zh-CN", messages: { [descriptor.id]: "内置" } })
    expect(navigationEntryLabel(builtIn, i18n._.bind(i18n))).toBe("内置")
    expect(navigationEntryLabel(plugin, i18n._.bind(i18n))).toBe("Author label")
  })
})
