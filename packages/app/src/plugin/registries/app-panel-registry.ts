import type { Component } from "solid-js"

export interface AppPanelContentProps {
  pluginId: string
  panelId: string
  scopeId?: string
}

export interface AppPanelEntry {
  id: string
  panelId: string
  label: string
  icon: string
  order?: number
  component?: Component<AppPanelContentProps>
  loader?: () => Promise<{ default: Component<AppPanelContentProps> }>
  sandbox?: boolean
  sandboxUrl?: string
  pluginId: string
  exportName?: string
}

const entries = new Map<string, AppPanelEntry>()
const listeners = new Set<() => void>()

function entryKey(pluginId: string, panelId: string) {
  return `${pluginId}:${panelId}`
}

function notify() {
  for (const listener of listeners) listener()
}

export function registerAppPanel(entry: AppPanelEntry): () => void {
  entries.set(entry.id, entry)
  notify()
  return () => {
    entries.delete(entry.id)
    notify()
  }
}

export function listAppPanels(): AppPanelEntry[] {
  return Array.from(entries.values()).toSorted(
    (a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label),
  )
}

export function getAppPanel(pluginId: string, panelId: string): AppPanelEntry | undefined {
  return entries.get(entryKey(pluginId, panelId))
}

export function clearAppPanels(pluginId?: string): void {
  if (!pluginId) {
    if (entries.size === 0) return
    entries.clear()
    notify()
    return
  }

  let changed = false
  for (const [id, entry] of entries) {
    if (entry.pluginId !== pluginId) continue
    entries.delete(id)
    changed = true
  }
  if (changed) notify()
}

export function subscribeAppPanels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
