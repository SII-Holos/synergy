export interface PluginCommandContext {
  pluginId: string
  serverUrl: string
}

export type PluginUICommand = (context: PluginCommandContext) => void | Promise<void>

export interface UICommandEntry {
  id: string
  commandId: string
  label: string
  description?: string
  icon?: string
  pluginId: string
  loader?: () => Promise<{ default: PluginUICommand }>
}

const entries = new Map<string, UICommandEntry>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function registerUICommand(entry: UICommandEntry): () => void {
  entries.set(entry.id, entry)
  notify()
  return () => {
    entries.delete(entry.id)
    notify()
  }
}

export function listUICommands(): UICommandEntry[] {
  return Array.from(entries.values()).toSorted((a, b) => a.label.localeCompare(b.label))
}

export function getUICommand(id: string): UICommandEntry | undefined {
  return entries.get(id)
}

export function clearUICommands(pluginId?: string): void {
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

export function subscribeUICommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
