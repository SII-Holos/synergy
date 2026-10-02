import { describe, expect, test } from "bun:test"
import { setupI18n, type MessageDescriptor } from "@lingui/core"
import type { SettingsSection } from "@/plugin"
import {
  localizeSettingsSection,
  settingsSectionGroupKey,
} from "../../../src/components/settings/settings-section-copy"
import { settingsGroupOrder } from "../../../src/components/settings/catalog"

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
        "settings.catalog.group.personal": "个人偏好",
        "settings.catalog.general.description": "外观、行为与通知偏好。",
        "settings.catalog.general.searchTerms": "外观 | 语言",
        "settings.general.language.title": "界面语言",
      },
    })

    expect(localizeSettingsSection(builtin, (descriptor: MessageDescriptor) => i18n._(descriptor))).toMatchObject({
      label: "常规",
      group: "个人偏好",
      description: "外观、行为与通知偏好。",
      keywords: ["外观 | 语言"],
    })
    expect(localizeSettingsSection(builtin, (descriptor) => i18n._(descriptor)).rowLabels).toContain("界面语言")
  })

  test("keeps built-in group ordering stable after localization", () => {
    const i18n = setupI18n({ locale: "zh-CN" })
    i18n.loadAndActivate({
      locale: "zh-CN",
      messages: { "settings.catalog.group.personal": "个人偏好" },
    })
    const localized = localizeSettingsSection(builtin, (descriptor: MessageDescriptor) => i18n._(descriptor))
    const groupKey = settingsSectionGroupKey(localized)

    expect(localized.group).toBe("个人偏好")
    expect(groupKey).toBe("personal")
    expect(settingsGroupOrder(groupKey)).toBe(0)
  })

  test("preserves plugin-author metadata verbatim", () => {
    const i18n = setupI18n({ locale: "zh-CN" })
    i18n.loadAndActivate({ locale: "zh-CN", messages: {} })
    expect(localizeSettingsSection(plugin, (descriptor: MessageDescriptor) => i18n._(descriptor))).toBe(plugin)
    expect(settingsSectionGroupKey(plugin)).toBe("plugin:Plugin Group")
  })
})
