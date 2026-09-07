import { JsonValue } from "@/util/json-value"
import z from "zod"
import { Decimal } from "decimal.js"
import type { RolloutUsage } from "@/session/rollout/usage"

export namespace ProviderPricing {
  const Rate = z.number().finite().nonnegative().nullable()
  const Rates = z.object({ input: Rate, output: Rate, cacheRead: Rate, cacheWrite: Rate, cacheWrite1h: Rate }).strict()
  const UnitRate = z.object({ price: z.number().finite().nonnegative(), per: z.number().finite().positive() }).strict()
  export const UnitRates = z
    .object({
      audio_seconds: UnitRate.optional(),
      audio_input_tokens: UnitRate.optional(),
      audio_output_tokens: UnitRate.optional(),
      characters: UnitRate.optional(),
    })
    .strict()
  const TokenRates = z
    .object({
      input: z.number().finite().nonnegative().optional(),
      output: z.number().finite().nonnegative().optional(),
      cache_read: z.number().finite().nonnegative().optional(),
      cache_write: z.number().finite().nonnegative().optional(),
      cache_write_1h: z.number().finite().nonnegative().optional(),
    })
    .strict()
  const ContextTier = TokenRates.extend({
    tier: z.object({ type: z.literal("context"), size: z.number().int().positive() }).strict(),
  }).strict()
  export const Cost = TokenRates.extend({
    context_over_200k: TokenRates.optional(),
    tiers: z.array(ContextTier).optional(),
    units: UnitRates.optional(),
  }).strict()
  export const CatalogCost = Cost.extend({
    input_audio: z.number().finite().nonnegative().optional(),
    output_audio: z.number().finite().nonnegative().optional(),
    reasoning: z.number().finite().nonnegative().optional(),
  }).loose()
  export const Info = z
    .object({
      version: z.literal(1),
      currency: z.literal("USD"),
      unitTokens: z.literal(1_000_000),
      source: z.object({
        kind: z.enum(["catalog", "configuration", "mixed"]),
        providerID: z.string(),
        modelID: z.string(),
      }),
      capturedAt: z.number(),
      rates: Rates,
      over200K: Rates.optional(),
      contextTiers: z.array(z.object({ above: z.number().int().positive(), rates: Rates })).optional(),
      units: UnitRates.optional(),
      raw: JsonValue,
    })
    .strict()
  export type Info = z.infer<typeof Info>
  export const Estimate = z
    .object({
      version: z.literal(1),
      currency: z.literal("USD").nullable(),
      basis: z.enum(["api_price_estimate", "subscription_api_equivalent"]),
      total: z.number().finite().nonnegative().nullable(),
      known: z.number().finite().nonnegative(),
      missing: z.array(z.string()),
    })
    .strict()
  export type Estimate = z.infer<typeof Estimate>
  type RawRates = z.infer<typeof TokenRates>
  type Cost = z.infer<typeof Cost>
  const rate = (value: number | undefined, inherited: number | null | undefined) =>
    value === undefined ? (inherited ?? null) : Number.isFinite(value) && value >= 0 ? value : null
  function rates(cost: RawRates, inherited?: Info["rates"]): Info["rates"] {
    return {
      input: rate(cost.input, inherited?.input),
      output: rate(cost.output, inherited?.output),
      cacheRead: rate(cost.cache_read, inherited?.cacheRead),
      cacheWrite: rate(cost.cache_write, inherited?.cacheWrite),
      cacheWrite1h: rate(cost.cache_write_1h, inherited?.cacheWrite1h),
    }
  }

  export function resolve(input: {
    providerID: string
    modelID: string
    cost?: Cost
    source: "catalog" | "configuration"
    inherited?: Info | null
  }): Info | null {
    if (!input.cost) return input.inherited ?? null
    const catalog = input.source === "catalog" ? CatalogCost.parse(input.cost) : undefined
    const audio = {
      ...(catalog?.input_audio === undefined
        ? {}
        : { audio_input_tokens: { price: catalog.input_audio, per: 1_000_000 } }),
      ...(catalog?.output_audio === undefined
        ? {}
        : { audio_output_tokens: { price: catalog.output_audio, per: 1_000_000 } }),
    }
    return {
      version: 1,
      currency: "USD",
      unitTokens: 1_000_000,
      source: { kind: input.inherited ? "mixed" : input.source, providerID: input.providerID, modelID: input.modelID },
      capturedAt: Date.now(),
      rates: rates(input.cost, input.inherited?.rates),
      over200K: input.cost.context_over_200k
        ? rates(input.cost.context_over_200k, input.inherited?.over200K)
        : input.inherited?.over200K,
      contextTiers:
        input.cost.tiers
          ?.map((tier) => ({ above: tier.tier.size, rates: rates(tier, rates(input.cost!, input.inherited?.rates)) }))
          .sort((a, b) => a.above - b.above) ?? input.inherited?.contextTiers,
      raw: JSON.parse(JSON.stringify(input.cost)),
      units:
        Object.keys(audio).length || input.cost.units
          ? { ...input.inherited?.units, ...audio, ...input.cost.units }
          : input.inherited?.units,
    }
  }

  export function estimate(pricing: Info | null, usage: RolloutUsage.Info | undefined, providerID: string): Estimate {
    if (usage?.serviceTier && !["default", "standard", "auto"].includes(usage.serviceTier))
      return {
        version: 1,
        currency: pricing?.currency ?? null,
        basis: providerID === "openai-codex" ? "subscription_api_equivalent" : "api_price_estimate",
        total: null,
        known: 0,
        missing: [`service_tier.${usage.serviceTier}.price`],
      }
    const selected = pricing?.contextTiers?.length
      ? usage?.input.total == null
        ? undefined
        : (pricing.contextTiers.findLast((tier) => usage.input.total! > tier.above)?.rates ?? pricing.rates)
      : pricing?.over200K
        ? usage?.input.total === null || usage?.input.total === undefined
          ? undefined
          : usage.input.total > 200_000
            ? pricing.over200K
            : pricing.rates
        : pricing?.rates
    const units = {
      input: usage?.input.uncached,
      output: usage?.output.total,
      cacheRead: usage?.input.cacheRead,
      cacheWrite: usage?.input.cacheWrite,
    }
    const missing: string[] = []
    let known = new Decimal(0)
    function charge(key: string, count: number | null | undefined, price: number | null | undefined, per: number) {
      if (count === null || count === undefined) {
        missing.push(`${key}.usage`)
        return
      }
      if (count === 0) return
      if (price === null || price === undefined) {
        missing.push(`${key}.price`)
        return
      }
      const next = known.add(new Decimal(count).mul(price).div(per))
      if (!Number.isFinite(next.toNumber())) {
        missing.push(`${key}.overflow`)
        return
      }
      known = next
    }
    for (const unit of usage?.units ?? []) {
      const rate = pricing?.units?.[unit.unit]
      let quantity = unit.quantity
      if (unit.unit === "audio_input_tokens") {
        if (quantity !== 0 && usage?.input.cacheRead !== 0) {
          units.input = null
          units.cacheRead = null
          quantity = null
          missing.push("audio_input_tokens.cache_overlap")
        } else if (units.input == null || quantity == null || quantity > units.input) {
          units.input = null
          quantity = null
        } else units.input -= quantity
      }
      if (unit.unit === "audio_output_tokens") {
        if (units.output == null || quantity == null || quantity > units.output) {
          units.output = null
          quantity = null
        } else units.output -= quantity
      }
      charge(unit.unit, quantity, rate?.price, rate?.per ?? 1)
    }
    if (usage?.billing !== "units") {
      for (const key of ["input", "output", "cacheRead"] as const)
        charge(key, units[key], selected?.[key], pricing?.unitTokens ?? 1_000_000)
      if (usage?.protocol === "anthropic" && units.cacheWrite) {
        const categories = usage.cacheWrites
        if (
          categories.ephemeral_5m == null ||
          categories.ephemeral_1h == null ||
          categories.ephemeral_5m + categories.ephemeral_1h !== units.cacheWrite
        )
          missing.push("cacheWrite.categories")
        else {
          charge("cacheWrite5m", categories.ephemeral_5m, selected?.cacheWrite, pricing?.unitTokens ?? 1_000_000)
          charge("cacheWrite1h", categories.ephemeral_1h, selected?.cacheWrite1h, pricing?.unitTokens ?? 1_000_000)
        }
      } else charge("cacheWrite", units.cacheWrite, selected?.cacheWrite, pricing?.unitTokens ?? 1_000_000)
    }
    return {
      version: 1,
      currency: pricing?.currency ?? null,
      basis: providerID === "openai-codex" ? "subscription_api_equivalent" : "api_price_estimate",
      total: missing.length ? null : known.toNumber(),
      known: known.toNumber(),
      missing,
    }
  }
}
