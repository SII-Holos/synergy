import type { Component } from "solid-js"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { BUILTIN_SETTINGS_SECTIONS } from "@/components/settings/catalog"

export interface SettingsSection {
  id: string
  label: string
  icon?: string
  iconToken?: SemanticIconTokenName
  group: string
  order?: number
  description?: string
  keywords?: string[]
  domainIds?: string[]
  rowLabels?: string[]
  hidden?: boolean
  component?: Component
  loader?: () => Promise<{ default: Component }> // lazy-load for Tier 2
  sandbox?: boolean
  sandboxUrl?: string
  pluginId?: string // undefined for built-in
  exportName?: string // named export from the plugin UI bundle (for lazy loading)
}
const sections: SettingsSection[] = []

export function registerSettingsSection(section: SettingsSection): () => void {
  sections.push(section)
  return () => {
    const index = sections.indexOf(section)
    if (index !== -1) sections.splice(index, 1)
  }
}

export function getSettingsSections(): SettingsSection[] {
  return [...sections]
}

/** Look up a single settings section by id. */
export function getSettingsSection(id: string): SettingsSection | undefined {
  return sections.find((s) => s.id === id)
}

// Built-in settings sections — registered at module init, consumed by SettingsDialog via getSettingsSections()
const BUILTIN_SECTIONS: SettingsSection[] = BUILTIN_SETTINGS_SECTIONS.map((section) => ({ ...section }))

for (const section of BUILTIN_SECTIONS) {
  registerSettingsSection(section)
}
