export type StoredScope = { id: string; expanded: boolean; pinned?: number }
export type LegacyScope = { worktree: string; expanded: boolean; pinned?: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function migrateServerPreferences(value: unknown) {
  const previous = record(value) ? value : {}
  const scopes: Record<string, StoredScope[]> = {}
  const legacyScopes: Record<string, LegacyScope[]> = {}
  for (const source of [previous.legacyScopes, previous.scopes]) {
    if (!record(source)) continue
    for (const [connection, entries] of Object.entries(source)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (!record(entry)) continue
        const state = {
          expanded: entry.expanded !== false,
          ...(typeof entry.pinned === "number" && Number.isFinite(entry.pinned) ? { pinned: entry.pinned } : {}),
        }
        if (typeof entry.id === "string" && entry.id) (scopes[connection] ??= []).push({ id: entry.id, ...state })
        else if (typeof entry.worktree === "string" && entry.worktree) {
          const pending = (legacyScopes[connection] ??= [])
          if (!pending.some((item) => item.worktree === entry.worktree))
            pending.push({ worktree: entry.worktree, ...state })
        }
      }
    }
  }
  return {
    list: Array.isArray(previous.list) ? previous.list.filter((item): item is string => typeof item === "string") : [],
    scopes,
    legacyScopes,
  }
}
