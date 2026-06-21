import type { Component } from "solid-js"

export interface WorkspacePanelEntry {
  id: string
  label: string
  icon: string // lucide icon name
  component?: Component // for Tier 2 (trusted import)
  sandbox?: boolean // for Tier 3 (iframe)
  sandboxUrl?: string
  pluginId: string
}

const entries: Map<string, WorkspacePanelEntry> = new Map()

export function registerWorkspacePanel(entry: WorkspacePanelEntry): () => void {
  entries.set(entry.id, entry)
  return () => {
    entries.delete(entry.id)
  }
}

export function listWorkspacePanels(): WorkspacePanelEntry[] {
  return Array.from(entries.values())
}

export function clearWorkspacePanels(pluginId?: string): void {
  if (pluginId) {
    for (const [id, entry] of entries) {
      if (entry.pluginId === pluginId) entries.delete(id)
    }
  } else {
    entries.clear()
  }
}
