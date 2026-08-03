import { pluginAssetUrl } from "@ericsanchezok/synergy-plugin/artifact"

export function resolvePluginAssetUrl(
  serverUrl: string,
  pluginId: string,
  generation: string,
  filePath: string,
): string {
  return `${serverUrl.replace(/\/+$/, "")}${pluginAssetUrl(pluginId, generation, filePath)}`
}
