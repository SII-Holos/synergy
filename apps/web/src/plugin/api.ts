import type { PluginManifestContribution, PluginUIArtifact } from "@ericsanchezok/synergy-plugin"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"

export interface PluginContribution {
  pluginId: string
  name: string
  version: string
  generation: string
  scopeId: string
  capabilities: string[]
  contributions: PluginManifestContribution[]
  uiArtifact?: PluginUIArtifact
}

export async function fetchUIContributions(
  serverUrl: string,
  scopeKey: string,
  signal?: AbortSignal,
): Promise<PluginContribution[]> {
  const sdk = createSynergyClient({
    baseUrl: serverUrl,
    throwOnError: true,
    ...(isHomeScope(scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }),
  })
  const response = await sdk.plugin.listUiContributions(undefined, { signal })
  return (response.data ?? []) as PluginContribution[]
}

/** Themes are a global preference: the aggregate spans every enabled scope. */
export async function fetchGlobalThemeContributions(serverUrl: string): Promise<PluginContribution[]> {
  const sdk = createSynergyClient({ baseUrl: serverUrl, throwOnError: true })
  const response = await sdk.plugin.listGlobalThemeContributions()
  return (response.data ?? []).map((entry) => ({
    pluginId: entry.pluginId,
    name: entry.name,
    version: entry.version,
    generation: entry.generation,
    // scopeId is unused on the theme asset path; keep the DTO shape compatible.
    scopeId: "home",
    capabilities: entry.capabilities,
    contributions: entry.contributions.filter((item) => (item as PluginManifestContribution).kind === "ui.theme"),
    uiArtifact: undefined,
  })) as PluginContribution[]
}
