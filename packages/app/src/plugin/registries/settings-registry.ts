import type { Component } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export interface SettingsSection {
  id: string
  label: string
  icon: string
  group: string
  component?: Component
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
const BUILTIN_SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: "sliders-horizontal", group: "Core" },
  { id: "models", label: "Models", icon: "cpu", group: "Core" },
  { id: "mcp", label: "MCP", icon: getSemanticIcon("connection.mcp"), group: "Integrations" },
  { id: "plugins", label: "Plugins", icon: "package", group: "Integrations" },
  { id: "email", label: "Email", icon: "mail", group: "Integrations" },
  { id: "channels", label: "Channels", icon: "globe", group: "Integrations" },
  { id: "identity", label: "Identity & Memory", icon: "fingerprint", group: "Identity" },
  { id: "advanced", label: "System", icon: "sliders-horizontal", group: "System" },
  { id: "config-sets", label: "Config Sets", icon: "layers", group: "System" },
]

for (const section of BUILTIN_SECTIONS) {
  registerSettingsSection(section)
}
