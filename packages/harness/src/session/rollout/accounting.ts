import z from "zod"
import { Decimal } from "decimal.js"
import type { RolloutSnapshot } from "./snapshot"
import type { RolloutSchema } from "./schema"

export namespace RolloutAccounting {
  export const Metric = z
    .object({
      known: z.number().finite().nonnegative(),
      unknown: z.number().int().nonnegative(),
      total: z.number().finite().nonnegative().nullable(),
    })
    .strict()
  export type Metric = z.infer<typeof Metric>
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
      reported: z
        .object({
          currencies: z.record(z.string(), z.number().finite().nonnegative()),
          unreported: z.number().int().nonnegative(),
        })
        .strict(),
      units: z.record(z.string(), Metric),
      cacheWrites: z.record(z.string(), Metric),
    })
    .strict()
    .meta({ ref: "RolloutAccountingSummary" })
  export type Summary = z.infer<typeof Summary>
  const zero = (): Metric => ({ known: 0, unknown: 0, total: 0 })
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
      reported: { currencies: {}, unreported: 0 },
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
      result.reported.unreported += summary.reported.unreported
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

  export function summarize(snapshot: Pick<RolloutSnapshot.Info, "calls" | "attempts" | "gaps">): Summary {
    const result = empty()
    result.importedCalls = snapshot.calls.filter((call) => call.source).length
    result.calls = snapshot.calls.length - result.importedCalls
    result.journalGaps = snapshot.gaps.length
    const calls = new Map(snapshot.calls.map((call) => [call.id, call]))
    const observed = new Set<string>()
    const attempts = new Set<string>()
    function charge(call: RolloutSchema.CallRecord, attempt?: RolloutSchema.AttemptRecord) {
      const usage = attempt?.usage
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
      for (const key of tokenKeys) add(result.tokens[key], values[key])
      const estimate = attempt?.estimate
      const target =
        (estimate?.basis ??
          (call.model.providerID === "openai-codex" ? "subscription_api_equivalent" : "api_price_estimate")) ===
        "subscription_api_equivalent"
          ? result.subscriptionEquivalent
          : result.apiEstimate
      add(target, amount(estimate?.total, estimate?.known ?? 0))
    }
    for (const attempt of snapshot.attempts) {
      if (attempts.has(attempt.id)) throw new Error("Duplicate rollout attempt in accounting input")
      attempts.add(attempt.id)
      const call = calls.get(attempt.callID)
      if (!call || call.runID !== attempt.runID) throw new Error("Rollout attempt has no owning call")
      if (call.source) continue
      observed.add(call.id)
      result.attempts++
      charge(call, attempt)
    }
    for (const call of snapshot.calls) {
      if (call.source) continue
      if (call.execution === "local") {
        result.localCalls++
        continue
      }
      if (observed.has(call.id)) continue
      result.unobservedCalls++
      charge(call)
    }
    return Summary.parse(result)
  }
}
