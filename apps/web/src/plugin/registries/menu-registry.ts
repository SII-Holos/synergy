import { createSignal } from "solid-js"
import type { PluginMenuLocation } from "@ericsanchezok/synergy-plugin"
import type { CommandOption } from "@/context/command-registry"

export interface PluginMenuEntry {
  id: string
  location: PluginMenuLocation
  order: number
  option(): CommandOption | undefined
  execute(): Promise<boolean>
}
export function createPluginMenuRegistry() {
  const [entries, setEntries] = createSignal<readonly PluginMenuEntry[]>([])
  return {
    register(entry: PluginMenuEntry) {
      if (entries().some((item) => item.id === entry.id)) throw new Error(`Duplicate plugin menu ${entry.id}`)
      setEntries((current) => [...current, entry])
      return () => setEntries((current) => current.filter((item) => item !== entry))
    },
    list(location: PluginMenuLocation) {
      return entries()
        .filter((item) => item.location === location && item.option())
        .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    },
  }
}
export const pluginMenus = createPluginMenuRegistry()
