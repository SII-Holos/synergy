import type { PluginManifestContribution } from "@ericsanchezok/synergy-plugin"
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
  uiArtifact?: { entry: string; sha256: string }
}

export async function fetchUIContributions(serverUrl: string, scopeKey: string): Promise<PluginContribution[]> {
  const sdk = createSynergyClient({
    baseUrl: serverUrl,
    throwOnError: true,
    ...(isHomeScope(scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }),
  })
  const response = await sdk.plugin.listUiContributions()
  return (response.data ?? []) as PluginContribution[]
}
