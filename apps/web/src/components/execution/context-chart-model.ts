import type { ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { contextCategories, type ContextCategory } from "./context-categories"

import { contextDisplay } from "./context-display"

export function contextSourceChanges(
  snapshot: ExecutionContextSnapshot | undefined,
  history: ExecutionContextSnapshot[],
) {
  if (!snapshot) return
  const display = contextDisplay(snapshot)
  if (!display.rows.length) return
  const previous = history.find(
    (entry) => entry.sessionID === snapshot.sessionID && entry.requestNumber === snapshot.requestNumber - 1,
  )
  const prior = contextDisplay(previous)
  if (!prior.rows.length || prior.total == null || display.total == null) return
  if ([...prior.rows, ...display.rows].some((entry) => entry.precision === "legacy")) return
  const before = new Map(prior.rows.map((row) => [row.category, row]))
  const changes = new Map<ContextCategory, { tokens: number; items?: number }>()
  for (const row of display.rows) {
    const prior = before.get(row.category)
    if (!prior) continue
    changes.set(row.category, {
      tokens: row.estimatedTokens - prior.estimatedTokens,
      items: row.items == null || prior.items == null ? undefined : row.items - prior.items,
    })
  }
  return changes
}

export function contextHistoryBars(items: ExecutionContextSnapshot[], grouping: "request" | "round", delta: boolean) {
  const chronological = [...items].sort((a, b) => a.started - b.started || a.callID.localeCompare(b.callID))
  const entries =
    grouping === "round" ? [...new Map(chronological.map((entry) => [entry.runID, entry])).values()] : chronological
  return entries.map((snapshot, index) => {
    const previous = entries[index - 1]
    const display = contextDisplay(snapshot)
    const prior = contextDisplay(previous)
    const gap =
      display.total == null ||
      (delta &&
        (!previous ||
          (grouping === "request"
            ? snapshot.requestNumber !== previous.requestNumber + 1
            : snapshot.roundNumber !== previous.roundNumber + 1) ||
          prior.total == null ||
          !prior.rows.length ||
          !display.rows.length ||
          prior.rows.some((entry) => entry.precision === "legacy") !==
            display.rows.some((entry) => entry.precision === "legacy")))
    const current = new Map(display.rows.map((row) => [row.category, row.attributedTokens]))
    if (!display.rows.length && display.total != null) current.set("overhead", display.total!)
    const before = new Map(prior.rows.map((row) => [row.category, row.attributedTokens]))
    const values = (Object.keys(contextCategories) as ContextCategory[])
      .map((category) => ({
        category,
        color: contextCategories[category].color,
        tokens: gap ? 0 : (current.get(category) ?? 0) - (delta ? (before.get(category) ?? 0) : 0),
      }))
      .filter((entry) => entry.tokens !== 0)
    return { snapshot, display, gap, values, total: gap ? null : display.total! - (delta ? prior.total! : 0) }
  })
}
