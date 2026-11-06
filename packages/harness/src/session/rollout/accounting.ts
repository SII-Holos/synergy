import z from "zod"
import { Decimal } from "decimal.js"
import type { RolloutSchema } from "./schema"
import { RolloutUsage } from "./usage"

export namespace RolloutAccounting {
  export const Metric = z
    .object({
      known: z.number().finite().nonnegative(),
      unknown: z.number().int().nonnegative(),
      total: z.number().finite().nonnegative().nullable(),
    })
    .strict()
  export type Metric = z.infer<typeof Metric>
  const CostBucket = z
    .object({
      attempts: z.number().int().nonnegative(),
      unreportedRequests: z.number().int().nonnegative().optional(),
      unreported: Metric,
      maximum: Metric,
    })
    .strict()
  export const CostCoverage = z
    .object({
      version: z.literal(1),
      api: CostBucket,
      subscription: CostBucket,
      unclassified: CostBucket,
      local: z.number().int().nonnegative(),
      historical: z.number().int().nonnegative(),
      historicalAmount: z.number().finite().nonnegative().optional(),
    })
    .strict()
  const tokenKeys = ["input", "uncached", "cacheRead", "cacheWrite", "output", "reasoning", "total"] as const
  export const Summary = z
    .object({
      version: z.literal(1),
      calls: z.number().int().nonnegative(),
      importedCalls: z.number().int().nonnegative(),
      localCalls: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
      unobservedCalls: z.number().int().nonnegative(),
      journalGaps: z.number().int().nonnegative(),
      legacy: z.object({ cost: z.number().finite(), messages: z.number().int().nonnegative() }).strict(),
      tokens: z
        .object({
          input: Metric,
          uncached: Metric,
          cacheRead: Metric,
          cacheWrite: Metric,
          output: Metric,
          reasoning: Metric,
          total: Metric,
        })
        .strict(),
      apiEstimate: Metric,
      subscriptionEquivalent: Metric,
      unclassifiedEquivalent: Metric.default({ known: 0, unknown: 0, total: 0 }),
      reported: z
        .object({
          currencies: z.record(z.string(), z.number().finite().nonnegative()),
          unreported: z.number().int().nonnegative(),
        })
        .strict(),
      costCoverage: CostCoverage.optional(),
      units: z.record(z.string(), Metric),
      cacheWrites: z.record(z.string(), Metric),
    })
    .strict()
    .meta({ ref: "RolloutAccountingSummary" })
  export type Summary = z.infer<typeof Summary>
  const zero = (): Metric => ({ known: 0, unknown: 0, total: 0 })
  const costBucket = () => ({ attempts: 0, unreportedRequests: 0, unreported: zero(), maximum: zero() })
  export function empty(): Summary {
    return {
      version: 1,
      calls: 0,
      localCalls: 0,
      importedCalls: 0,
      attempts: 0,
      unobservedCalls: 0,
      journalGaps: 0,
      legacy: { cost: 0, messages: 0 },
      tokens: {
        input: zero(),
        uncached: zero(),
        cacheRead: zero(),
        cacheWrite: zero(),
        output: zero(),
        reasoning: zero(),
        total: zero(),
      },
      apiEstimate: zero(),
      subscriptionEquivalent: zero(),
      unclassifiedEquivalent: zero(),
      reported: { currencies: {}, unreported: 0 },
      costCoverage: {
        version: 1,
        api: costBucket(),
        subscription: costBucket(),
        unclassified: costBucket(),
        local: 0,
        historical: 0,
      },
      units: {},
      cacheWrites: {},
    }
  }
  function add(target: Metric, source: Metric) {
    target.known = new Decimal(target.known).add(source.known).toNumber()
    target.unknown += source.unknown
    target.total = target.unknown ? null : target.known
  }
  function amount(total: number | null | undefined, known = total ?? 0): Metric {
    return { known, total: total ?? null, unknown: total === null || total === undefined ? 1 : 0 }
  }
  export function merge(summaries: Iterable<Summary>): Summary {
    const result = empty()
    for (const summary of summaries) {
      result.calls += summary.calls
      result.importedCalls += summary.importedCalls
      result.localCalls += summary.localCalls
      result.attempts += summary.attempts
      result.unobservedCalls += summary.unobservedCalls
      result.journalGaps += summary.journalGaps
      result.legacy.cost = new Decimal(result.legacy.cost).add(summary.legacy.cost).toNumber()
      result.legacy.messages += summary.legacy.messages
      for (const key of tokenKeys) add(result.tokens[key], summary.tokens[key])
      add(result.apiEstimate, summary.apiEstimate)
      add(result.subscriptionEquivalent, summary.subscriptionEquivalent)
      add(result.unclassifiedEquivalent, summary.unclassifiedEquivalent ?? zero())
      result.reported.unreported += summary.reported.unreported
      const coverage = result.costCoverage!
      if (summary.costCoverage) {
        for (const key of ["api", "subscription", "unclassified"] as const) {
          coverage[key].attempts += summary.costCoverage[key].attempts
          coverage[key].unreportedRequests =
            (coverage[key].unreportedRequests ?? 0) +
            (summary.costCoverage[key].unreportedRequests ??
              Number(!!summary.costCoverage[key].unreported.known || !!summary.costCoverage[key].unreported.unknown))
          add(coverage[key].unreported, summary.costCoverage[key].unreported)
          add(coverage[key].maximum, summary.costCoverage[key].maximum)
        }
        coverage.local += summary.costCoverage.local
        coverage.historical += summary.costCoverage.historical
        coverage.historicalAmount = new Decimal(coverage.historicalAmount ?? 0)
          .add(summary.costCoverage.historicalAmount ?? 0)
          .toNumber()
      } else {
        coverage.local += summary.localCalls
        coverage.historical += summary.attempts + summary.unobservedCalls
        const known = Object.keys(summary.reported.currencies).length
          ? 0
          : new Decimal(summary.apiEstimate.known).add(summary.unclassifiedEquivalent.known).toNumber()
        coverage.historicalAmount = new Decimal(coverage.historicalAmount ?? 0).add(known).toNumber()
      }
      for (const [currency, value] of Object.entries(summary.reported.currencies))
        result.reported.currencies[currency] = new Decimal(result.reported.currencies[currency] ?? 0)
          .add(value)
          .toNumber()
      for (const field of ["units", "cacheWrites"] as const)
        for (const [key, value] of Object.entries(summary[field])) add((result[field][key] ??= zero()), value)
    }
    return result
  }

  export function project(summary: Summary) {
    return {
      cost: summary.apiEstimate.known,
      tokens: {
        input: summary.tokens.uncached.known,
        output: summary.tokens.output.known,
        reasoning: summary.tokens.reasoning.known,
        cache: { read: summary.tokens.cacheRead.known, write: summary.tokens.cacheWrite.known },
      },
    }
  }

  export function knownExpense(summary: Summary, currency = "USD") {
    const reported = summary.reported.currencies[currency] ?? 0
    if (currency !== "USD") return reported
    const coverage = summary.costCoverage
    const estimated = coverage
      ? new Decimal(coverage.api.unreported.known)
          .add(coverage.unclassified.unreported.known)
          .add(coverage.historicalAmount ?? 0)
      : Object.keys(summary.reported.currencies).length
        ? new Decimal(0)
        : new Decimal(summary.apiEstimate.known).add(summary.unclassifiedEquivalent.known)
    return estimated.add(reported).add(summary.legacy.cost).toNumber()
  }

  export type CallInput = Pick<
    RolloutSchema.CallRecord,
    "id" | "runID" | "execution" | "model" | "sdkUsage" | "sdkEstimate" | "kind"
  > & { source?: unknown; usage?: RolloutUsage.Info }
  export type AttemptInput = Pick<
    RolloutSchema.AttemptRecord,
    "id" | "callID" | "runID" | "usage" | "estimate" | "timing"
  >
  export function summarize(snapshot: { calls: CallInput[]; attempts: AttemptInput[]; gaps: number[] }): Summary {
    const result = empty()
    result.importedCalls = snapshot.calls.filter((call) => call.source).length
    result.calls = snapshot.calls.length - result.importedCalls
    result.journalGaps = snapshot.gaps.length
    const calls = new Map(snapshot.calls.map((call) => [call.id, call]))
    const observed = new Set<string>()
    const attempts = new Set<string>()
    // Transport recording is best-effort: a request path that bypasses the
    // recording fetch still reports usage on its call record. Reading it keeps
    // token accounting — and the prompt budget's calibration anchor — alive
    // when recording is lost.
    function recordedCallUsage(call: CallInput) {
      return (
        call.usage ??
        (call.sdkUsage ? (RolloutUsage.normalizeSdk(call.sdkUsage, call.model.sdk, call.kind) ?? undefined) : undefined)
      )
    }
    function charge(call: CallInput, attempt?: AttemptInput) {
      const usage = attempt ? attempt.usage : recordedCallUsage(call)
      if (usage?.reported) {
        const { currency, amount } = usage.reported
        result.reported.currencies[currency] = new Decimal(result.reported.currencies[currency] ?? 0)
          .add(amount)
          .toNumber()
      } else result.reported.unreported++
      for (const unit of usage?.units ?? []) add((result.units[unit.unit] ??= zero()), amount(unit.quantity))
      for (const [category, count] of Object.entries(usage?.cacheWrites ?? {}))
        add((result.cacheWrites[category] ??= zero()), amount(count))
      const inputSubtotal =
        (usage?.input.uncached ?? 0) + (usage?.input.cacheRead ?? 0) + (usage?.input.cacheWrite ?? 0)
      const input = usage?.input.total
      const output = usage?.output.total
      const values = {
        input: amount(input, input ?? inputSubtotal),
        uncached: amount(usage?.input.uncached),
        cacheRead: amount(usage?.input.cacheRead),
        cacheWrite: amount(usage?.input.cacheWrite),
        output: amount(output),
        reasoning: amount(usage?.output.reasoning),
        total: amount(
          input != null && output != null ? input + output : null,
          (input ?? inputSubtotal) + (output ?? 0),
        ),
      }
      if (usage?.billing !== "units") for (const key of tokenKeys) add(result.tokens[key], values[key])
      if (call.model.billingMode === "local") {
        result.costCoverage!.local++
        return
      }
      const estimate = attempt ? attempt.estimate : call.sdkEstimate
      const basis =
        estimate?.basis ??
        (call.model.billingMode === "subscription"
          ? "subscription_api_equivalent"
          : call.model.billingMode === "api"
            ? "api_price_estimate"
            : "unclassified_api_equivalent")
      const target =
        basis === "subscription_api_equivalent"
          ? result.subscriptionEquivalent
          : basis === "api_price_estimate"
            ? result.apiEstimate
            : result.unclassifiedEquivalent
      add(target, amount(estimate?.total, estimate?.known ?? 0))
      const bucket =
        result.costCoverage![
          basis === "subscription_api_equivalent"
            ? "subscription"
            : basis === "api_price_estimate"
              ? "api"
              : "unclassified"
        ]
      bucket.attempts++
      if (!usage?.reported) {
        bucket.unreportedRequests = (bucket.unreportedRequests ?? 0) + 1
        add(bucket.unreported, amount(estimate?.range?.minimum ?? estimate?.total, estimate?.known ?? 0))
        add(bucket.maximum, amount(estimate?.range?.maximum ?? estimate?.total, estimate?.known ?? 0))
      }
    }
    for (const attempt of snapshot.attempts) {
      if (attempts.has(attempt.id)) throw new Error("Duplicate rollout attempt in accounting input")
      attempts.add(attempt.id)
      const call = calls.get(attempt.callID)
      if (!call || call.runID !== attempt.runID) throw new Error("Rollout attempt has no owning call")
      if (call.source) continue
      if (call.execution === "local") continue
      if (attempt.timing && attempt.timing.sentAt === undefined) continue
      observed.add(call.id)
      result.attempts++
      charge(call, attempt)
    }
    for (const call of snapshot.calls) {
      if (call.source) continue
      if (call.execution === "local") {
        result.localCalls++
        result.costCoverage!.local++
        continue
      }
      if (observed.has(call.id)) continue
      if (snapshot.attempts.some((attempt) => attempt.callID === call.id && attempt.timing)) continue
      result.unobservedCalls++
      charge(call)
    }
    if (snapshot.gaps.length) {
      for (const key of tokenKeys) add(result.tokens[key], { known: 0, total: null, unknown: snapshot.gaps.length })
      add(result.unclassifiedEquivalent, { known: 0, total: null, unknown: snapshot.gaps.length })
      result.costCoverage!.historical += snapshot.gaps.length
    }
    return Summary.parse(result)
  }
}
