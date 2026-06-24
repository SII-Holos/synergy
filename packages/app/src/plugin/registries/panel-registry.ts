import type { Component } from "solid-js"

export interface GlobalPanelEntry {
  id: string
  label: string
  icon: string
  component?: Component
  loader?: () => Promise<{ default: Component }> // lazy-load for Tier 2
  sandbox?: boolean
  sandboxUrl?: string
  pluginId: string
  exportName?: string // named export from the plugin UI bundle
}

const entries: Map<string, GlobalPanelEntry> = new Map()

export function registerGlobalPanel(entry: GlobalPanelEntry): () => void {
  entries.set(entry.id, entry)
  return () => {
    entries.delete(entry.id)
  }
}

export function listGlobalPanels(): GlobalPanelEntry[] {
  return Array.from(entries.values())
}

/** Look up a single global panel by id. */
export function getGlobalPanel(id: string): GlobalPanelEntry | undefined {
  return entries.get(id)
}

export function clearGlobalPanels(pluginId?: string): void {
  if (pluginId) {
    for (const [id, entry] of entries) {
      if (entry.pluginId === pluginId) entries.delete(id)
    }
  } else {
    entries.clear()
  }
}
// Built-in panels — register at module init
const BUILTIN_PANELS: GlobalPanelEntry[] = [
  { id: "engram", label: "Library", icon: "book-open", pluginId: "" },
  { id: "agenda", label: "Agenda", icon: "clipboard-list", pluginId: "" },
  { id: "lucid", label: "Lucid", icon: "sparkles", pluginId: "" },
]

for (const panel of BUILTIN_PANELS) {
  registerGlobalPanel(panel)
}
