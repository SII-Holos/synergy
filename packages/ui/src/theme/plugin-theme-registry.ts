import { builtinThemes } from "./default-themes"
import type { Theme } from "./types"

export interface PluginThemeDefinition {
  id: string
  label: string
  theme: Theme
  pluginId?: string
}

export interface ThemeDefinition extends PluginThemeDefinition {
  builtin: boolean
}

/**
 * Single theme registry. Built-in skins are pre-registered at module load and
 * plugin themes register into the same table — there is no parallel lookup
 * path. Built-in skin ids are reserved: a plugin theme may not shadow them.
 */
const builtinIds = new Set(builtinThemes.map((theme) => theme.id))
const themes = new Map<string, ThemeDefinition>()
const pluginThemeIds = new Set<string>()
const listeners = new Set<() => void>()
let registryReady = false

function notify() {
  for (const listener of listeners) listener()
}

for (const theme of builtinThemes) {
  themes.set(theme.id, { id: theme.id, label: theme.name, theme, builtin: true })
}

export function registerPluginTheme(theme: PluginThemeDefinition): () => void {
  if (builtinIds.has(theme.id)) return () => {}
  // Bind the disposer to this exact registration, not to the id: re-registering
  // the same id (even with the same Theme object) creates a new entry, and a
  // stale disposer must not remove the newer registration.
  const entry: ThemeDefinition = { ...theme, builtin: false }
  themes.set(theme.id, entry)
  pluginThemeIds.add(theme.id)
  notify()
  return () => {
    if (themes.get(theme.id) !== entry) return
    themes.delete(theme.id)
    pluginThemeIds.delete(theme.id)
    notify()
  }
}

export function replacePluginThemes(input: Iterable<PluginThemeDefinition>, options: { ready?: boolean } = {}): void {
  for (const id of pluginThemeIds) themes.delete(id)
  pluginThemeIds.clear()
  for (const theme of input) {
    if (builtinIds.has(theme.id)) continue
    themes.set(theme.id, { ...theme, builtin: false })
    pluginThemeIds.add(theme.id)
  }
  registryReady = options.ready ?? true
  notify()
}

export function isPluginThemeRegistryReady(): boolean {
  return registryReady
}

export function listPluginThemes(): PluginThemeDefinition[] {
  return [...themes.values()].filter((theme) => !theme.builtin).toSorted((a, b) => a.label.localeCompare(b.label))
}

export function getPluginTheme(id: string): PluginThemeDefinition | undefined {
  const entry = themes.get(id)
  return entry && !entry.builtin ? entry : undefined
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return themes.get(id)
}

export function listThemeChoices(): ThemeDefinition[] {
  const builtins = [...themes.values()].filter((theme) => theme.builtin)
  const pluginChoices = [...themes.values()]
    .filter((theme) => !theme.builtin)
    .toSorted((a, b) => a.label.localeCompare(b.label))
  return [...builtins, ...pluginChoices]
}

export function subscribePluginThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
