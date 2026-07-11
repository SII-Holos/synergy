import { synergyTheme } from "./default-themes"
import type { Theme } from "./types"

export interface PluginThemeDefinition {
  id: string
  label: string
  theme: Theme
  pluginId?: string
}

const pluginThemes = new Map<string, PluginThemeDefinition>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerPluginTheme(theme: PluginThemeDefinition): () => void {
  pluginThemes.set(theme.id, theme)
  notify()
  return () => {
    pluginThemes.delete(theme.id)
    notify()
  }
}

export function listPluginThemes(): PluginThemeDefinition[] {
  return Array.from(pluginThemes.values()).toSorted((a, b) => a.label.localeCompare(b.label))
}

export function getPluginTheme(id: string): PluginThemeDefinition | undefined {
  return pluginThemes.get(id)
}

export function listThemeChoices(): PluginThemeDefinition[] {
  return [{ id: synergyTheme.id, label: synergyTheme.name, theme: synergyTheme }, ...listPluginThemes()]
}

export function subscribePluginThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
