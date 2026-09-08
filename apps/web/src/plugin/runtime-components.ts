import { PLUGIN_UI_RUNTIME_KEY, type PluginUIComponents } from "@ericsanchezok/synergy-plugin/components"
import { pluginComponents } from "@ericsanchezok/synergy-ui/plugin-components"

export function installPluginComponents() {
  const runtime = globalThis as typeof globalThis & { [PLUGIN_UI_RUNTIME_KEY]?: PluginUIComponents }
  runtime[PLUGIN_UI_RUNTIME_KEY] ??= pluginComponents
}
