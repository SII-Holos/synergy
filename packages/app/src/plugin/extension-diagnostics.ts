import type { PluginExtensionId, PluginManifestContribution } from "@ericsanchezok/synergy-plugin"
import { PLUGIN_EXTENSIONS } from "@ericsanchezok/synergy-plugin"

export function pluginExtensionTarget(item: PluginManifestContribution): PluginExtensionId | undefined {
  if (item.kind === "ui.menu") return item.location
  if (item.kind === "ui.settings") return "settings.section"
  if (item.kind === "ui.navigationItem") return `navigation.${item.placement}`
  if (item.kind === "ui.workbenchPanel") return `workbench.${item.surface}`
  if (item.kind === "ui.slot" || item.kind === "ui.composerAction" || item.kind === "ui.messageSlot")
    return item.slot in PLUGIN_EXTENSIONS ? (item.slot as PluginExtensionId) : undefined
  return undefined
}
