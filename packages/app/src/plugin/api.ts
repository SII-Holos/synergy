import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

/** UI contributions shape matching the manifest's contributes.ui schema (all optional). */
export type PluginUIContributions = NonNullable<NonNullable<PluginManifest["contributes"]>["ui"]>

/** Permissions shape matching the manifest's permissions schema (all optional). */
export type PluginPermissions = NonNullable<PluginManifest["permissions"]>

/** A single plugin's aggregated UI contribution from the server. */
export interface PluginContribution {
  pluginId: string
  name: string
  version: string
  trustTier: "declarative" | "trusted-import" | "sandbox"
  ui: PluginUIContributions | null
  permissions: PluginPermissions | null
}

/**
 * Fetch aggregated UI contributions from the server.
 *
 * The server exposes this at /plugin/ui/contributions (mounted from PluginRoute).
 */
export async function fetchUIContributions(serverUrl: string): Promise<PluginContribution[]> {
  const sdk = createSynergyClient({ baseUrl: serverUrl, throwOnError: true })
  const res = await sdk.plugin.listUiContributions()
  return (res.data ?? []) as PluginContribution[]
}
