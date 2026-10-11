import type { ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { contextCategories, contextRows } from "./context-categories"

export function contextDisplay(snapshot: ExecutionContextSnapshot | undefined) {
  if (snapshot?.usage) return { total: snapshot.usage.totalInput, rows: contextRows(snapshot.usage), estimated: false }
  const estimate = snapshot?.estimate
  if (!estimate) return { total: snapshot?.inputTokens ?? null, rows: [], estimated: false }
  const rows: ReturnType<typeof contextRows> = Object.entries(contextCategories).flatMap(([category, display]) => {
    const entry = estimate.categories[category]
    if (!entry) return []
    return [
      {
        ...entry,
        ...display,
        category: category as keyof typeof contextCategories,
        precision: entry.precision ?? "source",
        attributedTokens: entry.estimatedTokens,
      },
    ]
  })
  return {
    total: rows.reduce((sum, row) => sum + row.attributedTokens, 0),
    rows: [
      ...rows,
      {
        category: "overhead" as const,
        precision: "source" as const,
        estimatedTokens: 0,
        attributedTokens: 0,
        items: undefined,
        ...contextCategories.overhead,
      },
    ],
    estimated: true,
  }
}
