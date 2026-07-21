export namespace SessionBounds {
  export const TOOL_INPUT_MAX_BYTES = 1_048_576
  export const TOOL_OUTPUT_MAX_CHARS = 32_000
  export const DIFF_PREVIEW_MAX_CHARS = 8_000
  export const DIFF_AGGREGATE_PREVIEW_MAX_BYTES = 1_048_576

  export function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8")
  }

  export function toolInputByteLength(input: unknown): number {
    return byteLength(JSON.stringify(input) ?? "")
  }

  export function toolInputExceededMessage(): string {
    return `Tool input exceeded ${TOOL_INPUT_MAX_BYTES} bytes`
  }

  export function middlePreview(value: string, maxChars: number): { text: string; truncated: boolean } {
    if (value.length <= maxChars) return { text: value, truncated: false }
    const omitted = value.length - maxChars
    const marker = `\n\n... [${omitted} characters omitted] ...\n\n`
    const budget = Math.max(0, maxChars - marker.length)
    const head = Math.ceil(budget / 2)
    const tail = budget - head
    return {
      text: `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`,
      truncated: true,
    }
  }

  export function toolOutput(value: string): { output: string; outputBytes: number; outputTruncated: boolean } {
    const preview = middlePreview(value, TOOL_OUTPUT_MAX_CHARS)
    return {
      output: preview.text,
      outputBytes: byteLength(value),
      outputTruncated: preview.truncated,
    }
  }

  export function diffPreview(value: string): { preview?: string; truncated?: boolean } {
    if (!value) return {}
    const preview = middlePreview(value, DIFF_PREVIEW_MAX_CHARS)
    return {
      preview: preview.text,
      ...(preview.truncated ? { truncated: true } : {}),
    }
  }
  export function diffAggregate<T extends { preview?: string; truncated?: boolean }>(diffs: readonly T[]): T[] {
    let previewBytes = 0
    return diffs.map((diff) => {
      if (!diff.preview) return diff
      const bytes = byteLength(diff.preview)
      if (previewBytes + bytes <= DIFF_AGGREGATE_PREVIEW_MAX_BYTES) {
        previewBytes += bytes
        return diff
      }
      const { preview: _, ...metadata } = diff
      return { ...metadata, truncated: true } as T
    })
  }
}
