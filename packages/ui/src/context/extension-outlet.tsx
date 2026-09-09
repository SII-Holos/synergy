import { createContext, createSignal, onCleanup, useContext } from "solid-js"
import { PLUGIN_EXTENSIONS, type PluginExtensionId } from "@ericsanchezok/synergy-plugin"

export function createExtensionOutlets() {
  const [outlets, setOutlets] = createSignal<ReadonlyMap<PluginExtensionId, number>>(new Map())
  const mounted = (id: PluginExtensionId) => (outlets().get(id) ?? 0) > 0
  return {
    mounted,
    missingRequired: () =>
      (Object.keys(PLUGIN_EXTENSIONS) as PluginExtensionId[]).filter(
        (id) => PLUGIN_EXTENSIONS[id].required && !mounted(id),
      ),
    register(id: string) {
      if (!(id in PLUGIN_EXTENSIONS)) return () => {}
      const key = id as PluginExtensionId
      setOutlets((current) => new Map(current).set(key, (current.get(key) ?? 0) + 1))
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        setOutlets((current) => {
          const next = new Map(current)
          const count = (next.get(key) ?? 1) - 1
          if (count) next.set(key, count)
          else next.delete(key)
          return next
        })
      }
    },
  }
}
const ExtensionOutlets = createContext<ReturnType<typeof createExtensionOutlets>>()
export const ExtensionOutletsProvider = ExtensionOutlets.Provider
export const useExtensionOutlets = () => useContext(ExtensionOutlets)
export function useExtensionOutlet(id: string) {
  const outlets = useExtensionOutlets()
  if (outlets) onCleanup(outlets.register(id))
}
