export namespace SessionToolInput {
  function isRecord(input: unknown): input is Record<string, unknown> {
    return !!input && typeof input === "object" && !Array.isArray(input)
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

  export function fromStream(raw: string | undefined): Record<string, unknown> | undefined {
    if (!raw) return
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return
    }
  }
}
