import type { Component } from "solid-js"
import { PLUGIN_UI_API_VERSION, type PluginSettingsComponentProps } from "@ericsanchezok/synergy-plugin"
import { loadPluginExport } from "./loaders"

type SettingsComponentModule = { default: Component<PluginSettingsComponentProps> }
type SettingsExportLoader = (
  pluginId: string,
  assetUrl: string,
  exportName: string,
  uiApiVersion: string,
) => Promise<SettingsComponentModule>

export function createPluginSettingsSurfaceLoader(
  input: { pluginId: string; assetUrl: string; exportName: string },
  load: SettingsExportLoader = loadPluginExport,
): () => Promise<SettingsComponentModule> {
  return () => load(input.pluginId, input.assetUrl, input.exportName, PLUGIN_UI_API_VERSION)
}
