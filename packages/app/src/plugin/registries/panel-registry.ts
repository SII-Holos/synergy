import type { Component } from "solid-js"

export interface GlobalPanelEntry {
  id: string
  label: string
  icon: string
  component?: Component
  sandbox?: boolean
  sandboxUrl?: string
  pluginId: string
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
