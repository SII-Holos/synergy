import type { PluginWorkbenchService } from "@ericsanchezok/synergy-plugin"
import type { useWorkbenchPanels } from "@/context/workbench"

export function createWorkbenchService(source: ReturnType<typeof useWorkbenchPanels>): PluginWorkbenchService {
  return {
    panels: (surface) => source.panels(surface).map(({ id, label, cardinality }) => ({ id, label, cardinality })),
    tabs: (surface) => source.surface(surface).tabs(),
    active: (surface) => source.surface(surface).active(),
    opened: (surface) => source.surface(surface).opened(),
    show: (surface) => source.surface(surface).open(),
    hide: (surface) => source.surface(surface).close(),
    open: (panelId, resource) =>
      source.openPanel(panelId, {
        init: resource
          ? { resourceId: resource.id, title: resource.title, state: resource.state, source: "plugin" }
          : undefined,
      }),
    activate(id) {
      for (const name of ["side", "bottom"] as const) {
        const surface = source.surface(name)
        if (!surface.tabs().some((tab) => tab.id === id)) continue
        surface.setActive(id)
        surface.open()
        return
      }
      throw new Error(`Workbench tab ${id} is unavailable`)
    },
    move(surface, id, index) {
      if (!Number.isInteger(index) || index < 0) throw new Error("Workbench tab index must be a non-negative integer")
      if (
        !source
          .surface(surface)
          .tabs()
          .some((tab) => tab.id === id)
      )
        throw new Error(`Workbench tab ${id} is unavailable on ${surface}`)
      source.moveTab(surface, id, index)
    },
    update(id, patch) {
      if (
        !(["side", "bottom"] as const).some((name) =>
          source
            .surface(name)
            .tabs()
            .some((tab) => tab.id === id),
        )
      )
        throw new Error(`Workbench tab ${id} is unavailable`)
      source.updateTab(id, patch)
    },
    close: (id) => source.closeTab(id),
    beforeClose: (id, handler) => source.beforeClose(id, handler),
  }
}
