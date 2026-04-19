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

  export function outputReserve(limit?: Pick<Info, "output">, outputTokenMax = OUTPUT_TOKEN_MAX) {
    return Math.min(limit?.output ?? outputTokenMax, outputTokenMax)
  }

  export function usableInput(
    limit?: Info,
    options?: {
      outputTokenMax?: number
      inputBuffer?: number
    },
  ) {
    if (!limit || limit.context === 0) return 0

    const reserve = outputReserve(limit, options?.outputTokenMax)

    if (typeof limit.input === "number" && limit.input > 0) {
      if (options?.inputBuffer) {
        return Math.max(0, limit.input - Math.min(options.inputBuffer, reserve))
      }
      return limit.input
    }

    return Math.max(0, limit.context - reserve)
  }
}
