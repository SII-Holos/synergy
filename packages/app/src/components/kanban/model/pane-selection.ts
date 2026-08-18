import type { NavEntry } from "@/context/layout"

export const BOARD_PANE_CAP = 6

export type BoardPaneKind = "live" | "unavailable"

export type BoardPane = {
  /** Stable key: `${scopeKey}\n${sessionID}` (unavailable panes keep the pinned key). */
  key: string
  scopeKey: string
  sessionID: string
  kind: BoardPaneKind
  pinned: boolean
  entry?: NavEntry
}

export type BoardPaneSource = {
  scopeKey: string
  entry: NavEntry
}

export function splitPaneKey(key: string): { scopeKey: string; sessionID: string } {
  const sep = key.indexOf("\n")
  if (sep === -1) return { scopeKey: "", sessionID: key }
  return { scopeKey: key.slice(0, sep), sessionID: key.slice(sep + 1) }
}

/**
 * Mixed policy pane selection: pinned panes (in pinned order) always occupy
 * slots first; leftover pinned keys whose session is no longer visible become
 * "unavailable" placeholders (user can remove them); remaining slots are
 * filled by the other sources in sidebar recent order (the caller passes
 * `sources` already ordered like the sidebar recent list), up to `cap`.
 * Idle and unread sessions participate so the board mirrors the sidebar.
 */
export function computeBoardPanes(input: { pinned: string[]; sources: BoardPaneSource[]; cap?: number }): BoardPane[] {
  const cap = input.cap ?? BOARD_PANE_CAP
  const pinnedKeys = new Set(input.pinned)
  const byKey = new Map(input.sources.map((source) => [paneKey(source), source]))

  const panes: BoardPane[] = []
  for (const key of pinnedKeys) {
    if (panes.length >= cap) break
    const source = byKey.get(key)
    if (source) {
      panes.push({
        key,
        scopeKey: source.scopeKey,
        sessionID: source.entry.id,
        kind: "live",
        pinned: true,
        entry: source.entry,
      })
    } else {
      const { scopeKey, sessionID } = splitPaneKey(key)
      panes.push({ key, scopeKey, sessionID, kind: "unavailable", pinned: true })
    }
  }

  if (panes.length < cap) {
    for (const source of input.sources) {
      if (panes.length >= cap) break
      if (pinnedKeys.has(paneKey(source))) continue
      panes.push({
        key: paneKey(source),
        scopeKey: source.scopeKey,
        sessionID: source.entry.id,
        kind: "live",
        pinned: false,
        entry: source.entry,
      })
    }
  }

  return panes
}

function paneKey(source: BoardPaneSource): string {
  return `${source.scopeKey}\n${source.entry.id}`
}

export type PaneSnapshot = {
  keys: string[]
  map: Map<string, BoardPane>
}

/**
 * Keyed pane projection for layout rendering. Solid's `For` keys rows by item
 * identity, so recomputing `panes()` creates fresh objects even when the same
 * `pane.key` remains selected; keying rows by the stable key keeps each pane
 * mounted across status/navigation updates instead of rebuilding the whole
 * message tree (mirrors `buildConversationTimelineSnapshot`).
 */
export function buildPaneSnapshot(panes: BoardPane[]): PaneSnapshot {
  const keys: string[] = []
  const map = new Map<string, BoardPane>()
  for (const pane of panes) {
    keys.push(pane.key)
    map.set(pane.key, pane)
  }
  return { keys, map }
}
