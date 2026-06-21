import { synergyTheme } from "@ericsanchezok/synergy-ui/theme"

export interface ThemeDefinition {
  id: string
  label: string
  appearance?: "dark" | "light"
  variables: Record<string, string> // CSS custom properties
  pluginId?: string
}

const themes: Map<string, ThemeDefinition> = new Map()
let activeThemeId: string | null = null

export function registerTheme(theme: ThemeDefinition): () => void {
  themes.set(theme.id, theme)
  return () => {
    themes.delete(theme.id)
    if (activeThemeId === theme.id) {
      activeThemeId = null
    }
  }
}

export function listThemes(): ThemeDefinition[] {
  return Array.from(themes.values())
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return themes.get(id)
}

export function activateTheme(id: string): void {
  if (!themes.has(id)) return
  activeThemeId = id
}

export function getActiveThemeId(): string | null {
  return activeThemeId
}

export function getActiveTheme(): ThemeDefinition | undefined {
  if (!activeThemeId) return undefined
  return themes.get(activeThemeId)
}

// Register the built-in synergy theme at module init — must be after variable declarations
registerTheme({
  id: synergyTheme.id,
  label: synergyTheme.name,
  appearance: undefined,
  variables: {},
  pluginId: undefined,
})
