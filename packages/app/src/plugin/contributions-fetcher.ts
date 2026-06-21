import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

/** UI contributions shape matching the manifest's contributes.ui schema (all optional). */
export type PluginUIContributions = NonNullable<NonNullable<PluginManifest["contributes"]>["ui"]>

/** Permissions shape matching the manifest's permissions schema (all optional). */
export type PluginPermissions = NonNullable<PluginManifest["permissions"]>

/** A single plugin's aggregated UI contribution from the server. */
export interface PluginContribution {
  pluginId: string
  name: string
  version: string
  trustTier: "trusted" | "sandbox"
  ui: PluginUIContributions
  permissions: PluginPermissions
}

/** Fetches aggregated UI contributions from the server. */
export async function fetchContributions(serverUrl: string): Promise<PluginContribution[]> {
  const res = await fetch(`${serverUrl}/api/plugins/ui/contributions`)
  if (!res.ok) {
    throw new Error(`Failed to fetch contributions: ${res.status}`)
  }
  return res.json() as Promise<PluginContribution[]>
}
