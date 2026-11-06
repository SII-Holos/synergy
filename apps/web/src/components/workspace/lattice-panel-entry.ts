import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { WorkbenchPanelEntry } from "@/plugin/registries/workbench-panel-registry"

export function createLatticeWorkbenchPanel(label: string): WorkbenchPanelEntry {
  return {
    id: "lattice",
    label,
    icon: getSemanticIcon("prompt.lattice"),
    surface: "side",
    cardinality: "singleton",
    requiresSession: true,
    pluginId: "builtin",
    order: 17,
    loader: async () => ({ default: (await import("./tool-lattice")).LatticeWorkbenchContent }),
  }
}
