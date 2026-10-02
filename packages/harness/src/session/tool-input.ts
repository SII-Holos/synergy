export namespace SessionToolInput {
  export function isRecord(input: unknown): input is Record<string, unknown> {
    return !!input && typeof input === "object" && !Array.isArray(input)
  }

  export function canonical(input: unknown): Record<string, unknown> | unknown[] | string | number | boolean | null {
    if (input === undefined) return {}
    if (
      input === null ||
      isRecord(input) ||
      Array.isArray(input) ||
      ["string", "number", "boolean"].includes(typeof input)
    )
      return input as Record<string, unknown> | unknown[] | string | number | boolean | null
    throw new TypeError("Tool input must be a JSON value")
  }

  export function normalize(input: unknown): Record<string, unknown> {
    if (isRecord(input)) return input
    if (input === undefined || input === null) return {}

    if (typeof input === "string") {
      if (input.length === 0) return {}
      try {
        const parsed: unknown = JSON.parse(input)
        if (isRecord(parsed)) return parsed
      } catch {
        return { raw: input }
      }
      return { raw: input }
    }

    return { value: input }
  }
}
