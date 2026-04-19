export namespace ModelLimit {
  export interface Info {
    context: number
    input?: number
    output?: number
  }

  export const OUTPUT_TOKEN_MAX = 32_000

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
