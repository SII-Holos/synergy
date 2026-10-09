import type { ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { contextCategories, contextRows, type ContextCategory } from "./context-categories"

export function contextSourceChanges(
  snapshot: ExecutionContextSnapshot | undefined,
  history: ExecutionContextSnapshot[],
) {
  if (!snapshot?.usage) return
  const previous = history.find(
    (entry) => entry.sessionID === snapshot.sessionID && entry.requestNumber === snapshot.requestNumber - 1,
  )
  if (!previous?.usage || previous.inputTokens == null || snapshot.inputTokens == null) return
  if ([...previous.usage.categories, ...snapshot.usage.categories].some((entry) => entry.precision === "legacy")) return
  const before = new Map(contextRows(previous.usage).map((row) => [row.category, row]))
  const changes = new Map<ContextCategory, { tokens: number; items?: number }>()
  for (const row of contextRows(snapshot.usage)) {
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
    const gap =
      snapshot.inputTokens == null ||
      (delta &&
        (!previous ||
          (grouping === "request"
            ? snapshot.requestNumber !== previous.requestNumber + 1
            : snapshot.roundNumber !== previous.roundNumber + 1) ||
          previous.inputTokens == null ||
          !previous.usage ||
          !snapshot.usage ||
          previous.usage.categories.some((entry) => entry.precision === "legacy") !==
            snapshot.usage.categories.some((entry) => entry.precision === "legacy")))
    const current = new Map(contextRows(snapshot.usage ?? undefined).map((row) => [row.category, row.attributedTokens]))
    if (!snapshot.usage && snapshot.inputTokens != null) current.set("overhead", snapshot.inputTokens)
    const before = new Map(contextRows(previous?.usage ?? undefined).map((row) => [row.category, row.attributedTokens]))
    const values = (Object.keys(contextCategories) as ContextCategory[])
      .map((category) => ({
        category,
        color: contextCategories[category].color,
        tokens: gap ? 0 : (current.get(category) ?? 0) - (delta ? (before.get(category) ?? 0) : 0),
      }))
      .filter((entry) => entry.tokens !== 0)
    return { snapshot, gap, values, total: gap ? null : snapshot.inputTokens! - (delta ? previous.inputTokens! : 0) }
  })
}
