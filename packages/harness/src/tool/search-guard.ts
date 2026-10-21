export namespace SearchGuard {
  export type FailureType =
    "no_results" | "http_403" | "http_404" | "timeout" | "blocked_or_unavailable" | "low_quality_results"

  export function classifyHttpStatus(status: number): FailureType | undefined {
    if (status === 403) return "http_403"
    if (status === 404) return "http_404"
    if (status === 408) return "timeout"
    if (status === 429 || status >= 500) return "blocked_or_unavailable"
    return undefined
  }

  export function classifyError(error: string): FailureType | undefined {
    const text = error.toLowerCase()
    if (/\b403\b/.test(text) || text.includes("forbidden")) return "http_403"
    if (/\b404\b/.test(text) || text.includes("not found")) return "http_404"
    if (/\b408\b/.test(text) || text.includes("timed out") || text.includes("timeout") || text.includes("aborterror"))
      return "timeout"
    if (
      text.includes("holoscapabilityunavailableerror") ||
      text.includes("connection was lost") ||
      text.includes("unavailable") ||
      text.includes("blocked") ||
      text.includes("captcha") ||
      text.includes("access denied") ||
      text.includes("rate limit") ||
      /\b429\b/.test(text)
    )
      return "blocked_or_unavailable"
    return undefined
  }

  export function assessWebContent(output: string, contentType: string) {
    if (!contentType.toLowerCase().includes("text/html")) return undefined
    const compact = output.replace(/\s+/g, " ").trim()
    if (compact.length === 0) {
      return {
        failureType: "low_quality_results" as const,
        reason: "Fetched HTML rendered to empty text; the page may require JavaScript or block static fetches.",
      }
    }
    if (compact.length < 300) {
      return {
        failureType: "low_quality_results" as const,
        reason:
          "Fetched HTML produced very little readable content; this may be a navigation shell, login page, or JavaScript-rendered page.",
      }
    }
    return undefined
  }

  export function appendQualityWarning(output: string, reason: string): string {
    return `${output}\n\n[Search quality warning] ${reason}`
  }
}
