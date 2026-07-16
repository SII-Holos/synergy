import { describe, expect, test } from "bun:test"
import { setupI18n, type MessageDescriptor } from "@lingui/core"
import type { SettingsSection } from "@/plugin"
import { localizeSettingsSection, settingsSectionGroupKey } from "./settings-section-copy"
import { settingsGroupOrder } from "./catalog"

const builtin: SettingsSection = {
  id: "general",
  label: "General",
  group: "Core",
  order: 10,
  description: "Appearance, behavior, and notification preferences.",
  keywords: ["appearance", "language"],
  rowLabels: ["Interface language"],
}

const plugin: SettingsSection = {
  id: "plugin:settings",
  pluginId: "plugin",
  label: "作者设置",
  group: "Plugin Group",
  description: "Plugin-provided description",
  keywords: ["plugin-keyword"],
}

describe("settings section localization", () => {
  test("resolves built-in metadata through the active Lingui catalog", () => {
    const i18n = setupI18n({ locale: "zh-CN" })
    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: {
        "settings.catalog.general.label": "常规",
        "settings.catalog.group.core": "核心",
        "settings.catalog.general.description": "外观、行为与通知偏好。",
        "settings.catalog.general.searchTerms": "外观 | 语言",
        "settings.catalog.general.row.interfaceLanguage": "界面语言",
      },
    })

    expect(localizeSettingsSection(builtin, (descriptor: MessageDescriptor) => i18n._(descriptor))).toMatchObject({
      label: "常规",
      group: "核心",
      description: "外观、行为与通知偏好。",
      keywords: ["外观 | 语言"],
      rowLabels: ["Color Scheme", "界面语言", "Snapshot", "Product Updates", "Notifications", "Toast Duration"],
    })
  })

  test("keeps built-in group ordering stable after localization", () => {
    const i18n = setupI18n({ locale: "zh-CN" })
    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: { "settings.catalog.group.core": "核心" },
    })
    const localized = localizeSettingsSection(builtin, (descriptor: MessageDescriptor) => i18n._(descriptor))
    const groupKey = settingsSectionGroupKey(localized)

    expect(localized.group).toBe("核心")
    expect(groupKey).toBe("Core")
    expect(settingsGroupOrder(groupKey)).toBe(1)
  })

  test("preserves plugin-author metadata verbatim", () => {
    const i18n = setupI18n({ locale: "zh-CN" })
    i18n.loadAndActivate({ locale: "zh-CN", messages: {} })
    expect(localizeSettingsSection(plugin, (descriptor: MessageDescriptor) => i18n._(descriptor))).toBe(plugin)
  })
})
