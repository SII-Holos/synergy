import type { RuntimeStatusRow } from "@ericsanchezok/synergy-util/runtime-startup"
import { PluginSpec } from "@ericsanchezok/synergy-harness/util/plugin-spec"
import { Plugin } from "./plugin"

export async function pluginStatus() {
  return pluginStatusRow(await Plugin.getLoaded(), await Plugin.getDisabled())
}

export function pluginStatusRow(
  loaded: Array<{ id: string; name: string }>,
  disabled: Array<{ pluginId: string }>,
): RuntimeStatusRow {
  if (loaded.length === 0 && disabled.length === 0) {
    return { label: "Plugins", value: "none configured", kind: "muted" }
  }
  const names = loaded.map((plugin) => plugin.name).join(", ")
  if (disabled.length === 0) return { label: "Plugins", value: names, kind: "success" }
  const unavailable = `${disabled.length} unavailable: ${disabled.map((plugin) => PluginSpec.displayName(plugin.pluginId)).join(", ")}`
  return { label: "Plugins", value: names ? `${names}; ${unavailable}` : unavailable, kind: "error" }
}
