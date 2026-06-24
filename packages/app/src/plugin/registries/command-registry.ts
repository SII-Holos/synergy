export interface PluginCommandEntry {
  id: string
  label: string
  description?: string
  icon?: string
  pluginId: string
  loader?: () => Promise<{ default: (context: { pluginId: string; serverUrl: string }) => void | Promise<void> }>
}

const entries: Map<string, PluginCommandEntry> = new Map()

export function registerPluginCommand(entry: PluginCommandEntry): () => void {
  entries.set(entry.id, entry)
  return () => {
    entries.delete(entry.id)
  }
}

export function listPluginCommands(): PluginCommandEntry[] {
  return Array.from(entries.values())
}

export function getPluginCommand(id: string): PluginCommandEntry | undefined {
  return entries.get(id)
}

export function clearPluginCommands(pluginId?: string): void {
  if (!pluginId) {
    entries.clear()
    return
  }
  for (const [id, entry] of entries) {
    if (entry.pluginId === pluginId) entries.delete(id)
  }
}
