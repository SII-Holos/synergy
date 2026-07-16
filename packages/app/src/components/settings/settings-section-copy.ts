import type { MessageDescriptor } from "@lingui/core"
import type { SettingsSection } from "@/plugin"
import { getBuiltinSettingsSection, isBuiltinSettingsId } from "./catalog"

export type TranslateSettingsDescriptor = (descriptor: MessageDescriptor) => string

export function localizeSettingsSection<T extends SettingsSection>(
  section: T,
  translate: TranslateSettingsDescriptor,
): T {
  if (section.pluginId || !isBuiltinSettingsId(section.id)) return section
  const catalogSection = getBuiltinSettingsSection(section.id)
  if (!catalogSection) return section

  return {
    ...section,
    label: translate(catalogSection.copy.label),
    group: translate(catalogSection.copy.group),
    description: translate(catalogSection.copy.description),
    keywords: [translate(catalogSection.copy.searchTerms)],
    rowLabels: catalogSection.copy.rowLabels.map(translate),
  }
}

export function settingsSectionGroupKey(section: SettingsSection): string {
  if (section.pluginId || !isBuiltinSettingsId(section.id)) return `plugin:${section.group || "Plugins"}`
  return getBuiltinSettingsSection(section.id)?.groupKey ?? `plugin:${section.group || "Plugins"}`
}
