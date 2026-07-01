import type { Component } from "solid-js"

export type WorkbenchPanelSurface = "side" | "bottom"
export type WorkbenchPanelCardinality = "exclusive" | "singleton" | "multi"

export interface WorkbenchPanelTab {
  id: string
  panelId: string
  resourceId?: string
  title?: string
  source?: string
}

export interface WorkbenchPanelContentProps {
  pluginId: string
  panelId: string
  tab: WorkbenchPanelTab
  onRequestClose?: () => void
}

export interface WorkbenchPanelTabInit {
  id?: string
  resourceId?: string
  title?: string
  source?: string
}

export interface WorkbenchPanelEntry {
  id: string
  label: string
  icon: string
  surface: WorkbenchPanelSurface
  cardinality: WorkbenchPanelCardinality
  requiresSession?: boolean
  component?: Component<WorkbenchPanelContentProps>
  loader?: () => Promise<{ default: Component<WorkbenchPanelContentProps> }>
  sandbox?: boolean
  sandboxUrl?: string
  pluginId: string
  exportName?: string
  order?: number
  createTab?: () => WorkbenchPanelTabInit | void | Promise<WorkbenchPanelTabInit | void>
  onCloseTab?: (tab: WorkbenchPanelTab) => void | Promise<void>
  title?: (tab: WorkbenchPanelTab) => string | undefined
}

const entries: Map<string, WorkbenchPanelEntry> = new Map()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerWorkbenchPanel(entry: WorkbenchPanelEntry): () => void {
  entries.set(entry.id, entry)
  notify()
  return () => {
    entries.delete(entry.id)
    notify()
  }
}

export function listWorkbenchPanels(surface?: WorkbenchPanelSurface): WorkbenchPanelEntry[] {
  const list = Array.from(entries.values())
  const filtered = surface ? list.filter((entry) => entry.surface === surface) : list
  return filtered.toSorted((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label))
}

export function getWorkbenchPanel(id: string): WorkbenchPanelEntry | undefined {
  return entries.get(id)
}

export function clearWorkbenchPanels(pluginId?: string): void {
  if (pluginId) {
    let changed = false
    for (const [id, entry] of entries) {
      if (entry.pluginId === pluginId) {
        entries.delete(id)
        changed = true
      }
    }
    if (changed) notify()
    return
  }
  entries.clear()
  notify()
}

export function subscribeWorkbenchPanels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
