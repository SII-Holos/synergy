import {
  ContextCategoryKeys,
  ContextUsageSchema,
  type ContextUsageDraft,
  type ContextUsageSnapshot,
} from "./context-usage-schema"

export function reconcileContextUsage(
  draft: ContextUsageDraft,
  totalInput: number,
  capturedAt = Date.now(),
): ContextUsageSnapshot {
  const exactTotal = integer(totalInput)
  const estimates = ContextCategoryKeys.map((key) => integer(draft.categories[key].estimatedTokens))
  const estimatedTotal = estimates.reduce((sum, value) => sum + value, 0)
  const scaledDown = estimatedTotal > exactTotal
  const attributed = scaledDown ? largestRemainder(estimates, exactTotal) : estimates
  return ContextUsageSchema.parse({
    version: 2,
    modelID: draft.modelID,
    providerID: draft.providerID,
    totalInput: exactTotal,
    contextLimit: integer(draft.contextLimit) || undefined,
    usableInputLimit: integer(draft.usableInputLimit) || undefined,
    categories: ContextCategoryKeys.map((category, index) => ({
      category,
      precision: draft.categories[category].precision ?? "source",
      estimatedTokens: estimates[index],
      attributedTokens: attributed[index],
      items: integer(draft.categories[category].items),
    })),
    overhead: { attributedTokens: exactTotal - attributed.reduce((sum, value) => sum + value, 0) },
    estimator: draft.estimator,
    reconciliation: {
      mode: scaledDown ? "scaled-down" : "residual",
      factor: scaledDown ? exactTotal / estimatedTotal : 1,
    },
    capturedAt: integer(capturedAt),
  })
}

function largestRemainder(estimates: number[], total: number): number[] {
  if (total === 0) return estimates.map(() => 0)
  const estimatedTotal = estimates.reduce((sum, tokens) => sum + tokens, 0)
  if (estimatedTotal === 0) return estimates.map(() => 0)
  const exact = estimates.map((tokens) => (tokens * total) / estimatedTotal)
  const allocated = exact.map(Math.floor)
  let remaining = total - allocated.reduce((sum, tokens) => sum + tokens, 0)
  const order = exact
    .map((tokens, index) => ({ index, remainder: tokens - allocated[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const entry of order) {
    if (remaining === 0) break
    allocated[entry.index]++
    remaining--
  }
  return allocated
}

function integer(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
