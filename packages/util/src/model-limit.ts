export namespace ModelLimit {
  export interface Info {
    context: number
    input?: number
    output?: number
  }

  export interface TokenUsage {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }

  export const OUTPUT_TOKEN_MAX = 32_000

  /**
   * Compute actual input tokens from a usage breakdown.
   *
   * For Anthropic-style providers, `input` excludes cached tokens — they are
   * reported separately as `cache.read` (cache hit) and `cache.write` (first
   * write). All three consume context window input space, so the true input
   * footprint is their sum.
   */
  export function actualInput(tokens: TokenUsage): number {
    return tokens.input + tokens.cache.read + tokens.cache.write
  }

  /**
   * Compute how many tokens are available for input within a model's context.
   *
   * Shared-context models (most LLMs) allow input to fill the entire context
   * window — the API enforces the limit at request time based on actual
   * input + output, not at input time. So we don't reserve output space.
   *
   * If the model config specifies an explicit `input` limit, use it directly.
   * Otherwise, the entire `context` window is usable for input.
   */
  export function usableInput(limit?: Info) {
    if (!limit || limit.context === 0) return 0

    if (typeof limit.input === "number" && limit.input > 0) {
      return limit.input
    }

    return limit.context
  }
}
