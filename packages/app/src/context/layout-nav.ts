import type { NavEntry, NavListState } from "./layout"

export function orderNavEntries(entries: readonly NavEntry[]): NavEntry[] {
  return entries.toSorted((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    if (a.pinned && b.pinned) return b.pinned - a.pinned
    return b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id)
  })
}

export function mergeNavListByID(previous: NavListState | undefined, next: NavListState): NavListState {
  if (!previous) return next

  const previousByID = new Map(previous.items.map((entry) => [entry.id, entry]))
  return {
    ...next,
    items: next.items.map((entry) => {
      const previousEntry = previousByID.get(entry.id)
      if (!previousEntry) return entry
      return { ...previousEntry, ...entry }
    }),
  }
}
