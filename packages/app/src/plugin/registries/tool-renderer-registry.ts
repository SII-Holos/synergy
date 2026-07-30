import type { ToolComponent } from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { notifyExternalToolLoaded, setExternalToolLookup } from "@ericsanchezok/synergy-ui/tool-registry-lazy"

type Loader = () => Promise<{ default: ToolComponent }>

const renderers = new Map<string, ToolComponent>()
const loaders = new Map<string, Loader>()
const loading = new Set<string>()

export function getPluginToolRenderer(name: string): ToolComponent | undefined {
  const renderer = renderers.get(name)
  if (renderer) return renderer
  const loader = loaders.get(name)
  if (!loader || loading.has(name)) return undefined
  loading.add(name)
  void loader()
    .then(
      (module) => {
        if (loaders.get(name) !== loader) return
        renderers.set(name, module.default)
        notifyExternalToolLoaded()
      },
      () => undefined,
    )
    .finally(() => loading.delete(name))
  return undefined
}

export function registerPluginToolRenderer(name: string, loader: Loader): () => void {
  loaders.set(name, loader)
  renderers.delete(name)
  return () => {
    if (loaders.get(name) !== loader) return
    loaders.delete(name)
    renderers.delete(name)
    loading.delete(name)
    notifyExternalToolLoaded()
  }
}

setExternalToolLookup(getPluginToolRenderer)
