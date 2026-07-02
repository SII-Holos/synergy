import type { Component } from "solid-js"

export interface AppRouteContentProps {
  pluginId: string
  routeId: string
}

export interface AppRouteEntry {
  id: string
  routeId: string
  label: string
  icon?: string
  component?: Component<AppRouteContentProps>
  loader?: () => Promise<{ default: Component<AppRouteContentProps> }>
  sandbox?: boolean
  sandboxUrl?: string
  pluginId: string
  exportName?: string
}

const entries = new Map<string, AppRouteEntry>()
const listeners = new Set<() => void>()

function entryKey(pluginId: string, routeId: string) {
  return `${pluginId}:${routeId}`
}

function notify() {
  for (const listener of listeners) listener()
}

export function registerAppRoute(entry: AppRouteEntry): () => void {
  entries.set(entry.id, entry)
  notify()
  return () => {
    entries.delete(entry.id)
    notify()
  }
}

export function listAppRoutes(): AppRouteEntry[] {
  return Array.from(entries.values())
}

export function getAppRoute(pluginId: string, routeId: string): AppRouteEntry | undefined {
  return entries.get(entryKey(pluginId, routeId))
}

export function clearAppRoutes(pluginId?: string): void {
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

export function subscribeAppRoutes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
