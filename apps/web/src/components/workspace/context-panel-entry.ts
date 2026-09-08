import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { WorkbenchPanelEntry } from "@/plugin/registries/workbench-panel-registry"

export function createContextWorkbenchPanel(label: string): WorkbenchPanelEntry {
  return {
    id: "context",
    label,
    icon: getSemanticIcon("session.context"),
    surface: "side",
    cardinality: "singleton",
    requiresSession: true,
    pluginId: "builtin",
    order: 12,
    loader: async () => ({ default: (await import("./tool-context")).ContextWorkbenchContent }),
    title: () => label,
  }
}
