import type { PerformanceSummary } from "./types"

export type ToolFailureItem = PerformanceSummary["top"]["toolFailures"][number]

export function toolFailureCategories(item: ToolFailureItem) {
  if (item.categories.length === 0) return "No error category reported"
  return item.categories.map((category) => `${category.errorClass} ×${category.count}`).join(" · ")
}
