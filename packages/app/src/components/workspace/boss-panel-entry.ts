import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { WorkbenchPanelEntry } from "@/plugin/registries/workbench-panel-registry"

export function createBossWorkbenchPanel(label: string): WorkbenchPanelEntry {
  return {
    id: "boss",
    label,
    icon: getSemanticIcon("prompt.boss"),
    surface: "side",
    cardinality: "singleton",
    requiresSession: true,
    pluginId: "builtin",
    order: 19,
    loader: async () => ({ default: (await import("./tool-boss")).BossWorkbenchContent }),
  }
}
