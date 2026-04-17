export namespace Token {
  const CHARS_PER_TOKEN = 4

  export function estimate(input: string) {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
  }

  /** Conservative token estimate for any serializable value. */
  export function estimateJSON(value: unknown): number {
    if (typeof value === "string") return estimate(value)
    try {
      return estimate(JSON.stringify(value))
    } catch {
      return 0
    }
  }
}
