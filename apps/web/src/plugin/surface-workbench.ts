import type { PluginUILifetime, PluginWorkbenchService } from "@ericsanchezok/synergy-plugin"
import type { createPluginSurfaceAccess } from "./surface-access"

export function bindPluginWorkbench(
  source: PluginWorkbenchService,
  access: ReturnType<typeof createPluginSurfaceAccess>,
  lifetime: PluginUILifetime,
): PluginWorkbenchService {
  const read = () => {
    access.require("workbench.read")
    return source
  }
  const write = () => {
    access.require("workbench.write")
    return source
  }
  return {
    panels: (surface) => read().panels(surface),
    tabs: (surface) => read().tabs(surface),
    active: (surface) => read().active(surface),
    opened: (surface) => read().opened(surface),
    show: (surface) => write().show(surface),
    hide: (surface) => write().hide(surface),
    open: (panelId, resource) => access.run("workbench.write", () => source.open(panelId, resource)),
    activate: (id) => write().activate(id),
    move: (surface, id, index) => write().move(surface, id, index),
    update: (id, patch) => write().update(id, patch),
    close: (id) => access.run("workbench.write", () => source.close(id)),
    beforeClose: (id, handler) => lifetime.onDispose(write().beforeClose(id, handler)),
  }
}
