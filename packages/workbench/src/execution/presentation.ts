import { z } from "zod"
import { RolloutAccounting } from "@ericsanchezok/synergy-harness/rollout"

export namespace ExecutionPresentation {
  const Estimate = z.object({
    basis: z.enum(["api", "unclassified", "subscription", "historical"]),
    currency: z.literal("USD"),
    known: z.number(),
    maximum: z.number(),
    unknown: z.number().int().nonnegative(),
  })
  export const Cost = z
    .object({
      state: z.enum(["unrecorded", "local", "subscription", "reported", "estimated", "mixed", "partial", "unknown"]),
      reported: z.array(z.object({ currency: z.string(), amount: z.number() })),
      estimates: z.array(Estimate),
      equivalent: Estimate.nullable(),
      missing: z.number().int().nonnegative(),
      historical: z.number().int().nonnegative(),
      knownUSD: z.number(),
    })
    .meta({ ref: "ExecutionCostPresentation" })
  export type Cost = z.infer<typeof Cost>

  export function cost(summary: RolloutAccounting.Summary): Cost {
    const reported = Object.entries(summary.reported.currencies)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount }))
    const coverage = summary.costCoverage
    const estimates: z.infer<typeof Estimate>[] = []
    const entry = (
      basis: z.infer<typeof Estimate>["basis"],
      metric: RolloutAccounting.Metric,
      maximum = metric.known,
    ) => ({ basis, currency: "USD" as const, known: metric.known, maximum, unknown: metric.unknown })
    if (coverage) {
      for (const basis of ["api", "unclassified"] as const) {
        const bucket = coverage[basis]
        if (
          (bucket.unreportedRequests ??
            Number(bucket.attempts && (bucket.unreported.known || bucket.unreported.unknown || !reported.length))) > 0
        )
          estimates.push(entry(basis, bucket.unreported, bucket.maximum.known))
      }
    }
    const historicalAmount =
      (coverage
        ? (coverage.historicalAmount ?? 0)
        : !reported.length
          ? summary.apiEstimate.known + summary.unclassifiedEquivalent.known
          : 0) + summary.legacy.cost
    if (historicalAmount)
      estimates.push(entry("historical", { known: historicalAmount, total: historicalAmount, unknown: 0 }))
    const equivalent = coverage?.subscription.attempts
      ? entry(
          "subscription",
          summary.subscriptionEquivalent,
          summary.subscriptionEquivalent.known +
            Math.max(0, coverage.subscription.maximum.known - coverage.subscription.unreported.known),
        )
      : null
    const historical = coverage
      ? coverage.historical + summary.legacy.messages
      : summary.attempts + summary.unobservedCalls + summary.legacy.messages
    const missing = estimates.reduce((count, estimate) => count + estimate.unknown, historical)
    const state: Cost["state"] = missing
      ? reported.length || estimates.some((estimate) => estimate.known)
        ? "partial"
        : "unknown"
      : reported.length
        ? estimates.length
          ? "mixed"
          : "reported"
        : estimates.length
          ? "estimated"
          : equivalent
            ? "subscription"
            : coverage?.local
              ? "local"
              : "unrecorded"
    return {
      state,
      reported,
      estimates,
      equivalent,
      missing,
      historical,
      knownUSD: RolloutAccounting.knownExpense(summary),
    }
  }
}
