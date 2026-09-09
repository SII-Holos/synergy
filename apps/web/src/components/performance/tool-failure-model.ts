import type { MessageDescriptor } from "@lingui/core"
import type { PerformanceSummary } from "./types"
import { P } from "./performance-i18n"

export type ToolFailureItem = PerformanceSummary["top"]["toolFailures"][number]

export function toolFailureCategories(item: ToolFailureItem): string | MessageDescriptor {
  if (item.categories.length === 0) return P.toolFailuresNone
  return item.categories.map((category) => `${category.errorClass} ×${category.count}`).join(" · ")
}
