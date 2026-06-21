import type { PluginContribution } from "./contributions-fetcher"

/** Shape returned by a Tier 2 plugin UI bundle's dynamic import. */
export interface PluginBundleExports {
  toolRenderers?: Record<string, unknown>
  partRenderers?: Record<string, unknown>
  panels?: Record<string, unknown>
  settings?: Record<string, unknown>
  chatComponents?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Load a Tier 2 plugin UI bundle via dynamic import.
 *
 * Only trusted (same-origin) plugins can be imported this way.
 * Sandbox plugins are hosted in iframes — throw early.
 */
export async function loadPluginBundle(contribution: PluginContribution): Promise<PluginBundleExports> {
  if (contribution.trustTier !== "trusted") {
    throw new Error(`Cannot dynamic-import sandbox plugin ${contribution.pluginId}`)
  }
  const entry = contribution.ui.entry
  if (!entry) return {}
  const url = `/plugin/assets/${contribution.pluginId}/${contribution.version}/${entry}`
  return (await import(/* @vite-ignore */ url)) as PluginBundleExports
}

/**
 * Load a single named export from a Tier 2 plugin's UI bundle.
 */
export async function loadPluginExport(contribution: PluginContribution, exportName: string): Promise<unknown> {
  const mod = await loadPluginBundle(contribution)
  return mod[exportName]
}
