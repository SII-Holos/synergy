import type { Component } from "solid-js"

export interface SettingsSection {
  id: string
  label: string
  icon: string
  group: string
  component?: Component
  sandbox?: boolean
  sandboxUrl?: string
  pluginId?: string // undefined for built-in
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

// Built-in settings sections — mirror the existing NAV_GROUPS from components/settings/types.ts
const BUILTIN_SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: "sliders-horizontal", group: "Core" },
  { id: "models", label: "Models", icon: "cpu", group: "Core" },
  { id: "mcp", label: "MCP", icon: "cable", group: "Integrations" },
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
