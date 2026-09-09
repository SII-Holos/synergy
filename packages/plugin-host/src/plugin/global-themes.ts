import { listCatalogPlugins, type LoadedPlugin } from "./loader"

export interface GlobalThemeContribution {
  pluginId: string
  name: string
  version: string
  generation: string
  enabledScopes: string[]
  capabilities: string[]
  contributions: Array<Record<string, unknown>>
  uiArtifact?: { entry: string; sha256: string }
}

/**
 * Themes are a global user preference (config general.theme) served from the
 * process-wide plugin catalog: a theme registered by any enabled scope stays
 * available across scope switches. The aggregate must not depend on
 * ScopeContext, or it would re-introduce scope-local visibility.
 */
export function listGlobalThemePlugins(): GlobalThemeContribution[] {
  return listCatalogPlugins()
    .filter(hasEnabledThemeContributions)
    .map((plugin) => ({
      pluginId: plugin.id,
      name: plugin.name,
      version: plugin.manifest.version,
      generation: plugin.manifest.artifacts.generation,
      enabledScopes: [...plugin.enabledScopes],
      capabilities: plugin.manifest.capabilities.map((capability) => capability.id),
      contributions: plugin.manifest.contributions.filter((item) => item.kind === "ui.theme"),
      uiArtifact: plugin.manifest.artifacts.ui,
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
}

function hasEnabledThemeContributions(plugin: LoadedPlugin): boolean {
  return plugin.enabledScopes.size > 0 && plugin.manifest.contributions.some((item) => item.kind === "ui.theme")
}
