import type { Component } from "solid-js"
import type { PluginSettingsComponentProps, PluginSettingsSurfaceContext } from "@ericsanchezok/synergy-plugin"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SurfaceRegistry } from "@/surface/registry"
import type { SurfaceEntry } from "@/surface/types"
import { BUILTIN_SETTINGS_SECTIONS } from "@/components/settings/catalog"

export interface SettingsSection extends SurfaceEntry {
  iconToken?: SemanticIconTokenName
  group: string
  scopeId?: string
  formSchema?: Record<string, unknown>
  description?: string
  keywords?: string[]
  domainIds?: string[]
  rowLabels?: string[]
  hidden?: boolean
  visibility?: "standard" | "developer"
  component?: Component<PluginSettingsComponentProps>
  context?: PluginSettingsSurfaceContext
  loader?: () => Promise<{ default: Component<PluginSettingsComponentProps> }>
  exportName?: string
}

const registry = new SurfaceRegistry<SettingsSection>()

export function registerSettingsSection(section: SettingsSection): () => void {
  return registry.register(section)
}

export function getSettingsSections(): SettingsSection[] {
  return registry.list()
}

export function getSettingsSection(id: string): SettingsSection | undefined {
  return registry.get(id)
}

export function subscribeSettingsSections(listener: () => void): () => void {
  return registry.subscribe(listener)
}

// Built-in settings sections — registered at module init, consumed by SettingsPanel via getSettingsSections()
const BUILTIN_SECTIONS: SettingsSection[] = BUILTIN_SETTINGS_SECTIONS.map((section) => ({ ...section }))

for (const section of BUILTIN_SECTIONS) {
  registerSettingsSection(section)
}
