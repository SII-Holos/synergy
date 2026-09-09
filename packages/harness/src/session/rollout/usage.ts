import { JsonValue } from "../../util/json-value"
import z from "zod"

export namespace RolloutUsage {
  const Count = z.number().finite().int().nonnegative().nullable()
  export const Info = z
    .object({
      version: z.literal(1),
      protocol: z.enum(["openai", "anthropic", "google", "unknown"]),
      raw: JsonValue.nullable(),
      input: z.object({ total: Count, uncached: Count, cacheRead: Count, cacheWrite: Count }),
      output: z.object({ total: Count, reasoning: Count }),
      cacheWrites: z.record(z.string(), Count),
      units: z.array(
        z
          .object({
            unit: z.enum(["audio_input_tokens", "audio_output_tokens", "audio_seconds", "characters"]),
            quantity: z.number().finite().nonnegative().nullable(),
          })
          .strict(),
      ),
      billing: z.enum(["tokens", "units", "unknown"]),
      serviceTier: z.string().optional(),
      reported: z
        .object({
          amount: z.number().finite().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          source: z.string(),
        })
        .strict()
        .nullable(),
      complete: z.boolean(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  function count(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
  function sum(...values: Array<number | null>) {
    return values.some((value) => value === null)
      ? null
      : count(values.reduce<number>((total, value) => total + value!, 0))
  }
  function difference(total: number | null, ...parts: Array<number | null>) {
    const subtotal = sum(...parts)
    return total === null || subtotal === null ? null : count(total - subtotal)
  }

  export function normalize(
    protocol: Info["protocol"],
    raw: z.infer<ReturnType<typeof z.json>> | null,
    kind?: "chat" | "embedding" | "rerank" | "transcription" | "speech",
    providerID?: string,
  ): Info {
    const usage = object(raw)
    const result: Info = {
      version: 1,
      protocol,
      raw,
      input: { total: null, uncached: null, cacheRead: null, cacheWrite: null },
      output: { total: null, reasoning: null },
      cacheWrites: {},
      units: [],
      billing: protocol === "unknown" ? "unknown" : "tokens",
      reported: null,
      complete: false,
    }
    if (protocol === "openai") {
      result.input.total = count(usage.input_tokens ?? usage.prompt_tokens)
      result.input.cacheRead = count(
        object(usage.input_tokens_details ?? usage.prompt_tokens_details).cached_tokens ??
          usage.prompt_cache_hit_tokens,
      )
      result.input.cacheWrite = count(object(usage.prompt_tokens_details).cache_write_tokens) ?? 0
      result.input.uncached =
        count(usage.prompt_cache_miss_tokens) ??
        difference(result.input.total, result.input.cacheRead, result.input.cacheWrite)
      result.output.total = count(usage.output_tokens ?? usage.completion_tokens)
      result.output.reasoning = count(
        object(usage.output_tokens_details ?? usage.completion_tokens_details).reasoning_tokens,
      )
      // Provider contracts: https://developers.openai.com/api/reference/resources/embeddings
      // https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
      if (kind === "embedding" || kind === "rerank") {
        if (result.input.total !== null && count(usage.total_tokens) === result.input.total) {
          result.input.uncached = result.input.total
          result.input.cacheRead = 0
          result.output = { total: 0, reasoning: 0 }
        }
      }
      const audioInput = object(usage.input_token_details ?? usage.input_tokens_details ?? usage.prompt_tokens_details)
      const audioOutput = object(usage.output_tokens_details ?? usage.completion_tokens_details)
      if ("audio_tokens" in audioInput)
        result.units.push({ unit: "audio_input_tokens", quantity: count(audioInput.audio_tokens) })
      if ("audio_tokens" in audioOutput)
        result.units.push({ unit: "audio_output_tokens", quantity: count(audioOutput.audio_tokens) })
      if (kind === "transcription" && usage.type === "tokens") {
        result.input.uncached = result.input.total
        result.input.cacheRead = 0
      }
      if (usage.type === "duration") {
        result.billing = "units"
        result.units.push({
          unit: "audio_seconds",
          quantity:
            typeof usage.seconds === "number" && Number.isFinite(usage.seconds) && usage.seconds >= 0
              ? usage.seconds
              : null,
        })
      }
    }
    // The account charge excludes the separately reported upstream cost; credits are USD-denominated.
    // https://openrouter.ai/docs/cookbook/administration/usage-accounting
    // https://openrouter.ai/docs/faq
    if (providerID === "openrouter" && typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0)
      result.reported = { amount: usage.cost, currency: "USD", source: "openrouter.usage.cost" }
    if (protocol === "anthropic") {
      result.input.uncached = count(usage.input_tokens)
      result.input.cacheRead = count(usage.cache_read_input_tokens)
      result.input.cacheWrite = count(usage.cache_creation_input_tokens)
      result.input.total = sum(result.input.uncached, result.input.cacheRead, result.input.cacheWrite)
      result.output.total = count(usage.output_tokens)
      // Cache durations are different billing categories, not additive token usage.
      // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
      const creation = object(usage.cache_creation)
      for (const category of ["ephemeral_5m", "ephemeral_1h"] as const) {
        if (`${category}_input_tokens` in creation)
          result.cacheWrites[category] = count(creation[`${category}_input_tokens`])
      }
    }
    if (protocol === "google") {
      result.input.total = count(usage.promptTokenCount)
      result.input.cacheRead = count(usage.cachedContentTokenCount)
      result.input.cacheWrite = 0
      result.input.uncached = difference(result.input.total, result.input.cacheRead)
      result.output.reasoning = count(usage.thoughtsTokenCount)
      result.output.total = sum(count(usage.candidatesTokenCount), result.output.reasoning)
    }
    const totalInput = sum(result.input.uncached, result.input.cacheRead, result.input.cacheWrite)
    if (result.input.total !== null && totalInput !== null && totalInput !== result.input.total)
      result.input.uncached = null
    if (
      result.output.total !== null &&
      result.output.reasoning !== null &&
      result.output.reasoning > result.output.total
    )
      result.output.reasoning = null
    result.complete =
      result.billing === "units"
        ? result.units.every((unit) => unit.quantity !== null)
        : result.input.total !== null &&
          result.input.uncached !== null &&
          result.input.cacheRead !== null &&
          result.input.cacheWrite !== null &&
          result.output.total !== null
    return result
  }
}
