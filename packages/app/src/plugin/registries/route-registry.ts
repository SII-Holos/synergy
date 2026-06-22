export interface PluginRouteEntry {
  path: string
  label: string
  icon?: string
  entry: string // html file path
  pluginId: string
}

const routes: PluginRouteEntry[] = []

export function registerPluginRoute(entry: PluginRouteEntry): () => void {
  routes.push(entry)
  return () => {
    const index = routes.indexOf(entry)
    if (index !== -1) routes.splice(index, 1)
  }
}

export function getPluginRoutes(): PluginRouteEntry[] {
  return [...routes]
}

export function clearPluginRoutes(pluginId?: string): void {
  if (pluginId) {
    for (let i = routes.length - 1; i >= 0; i--) {
      if (routes[i].pluginId === pluginId) routes.splice(i, 1)
    }
  } else {
    routes.length = 0
  }
}
