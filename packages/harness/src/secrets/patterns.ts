export namespace SecretPatterns {
  /**
   * Single inventory of standalone secret token shapes. Consumers
   * (observability redaction, heuristic capture) read from here so a new
   * provider prefix updates one place instead of drifting across copies.
   */
  export const standalone: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9._-]{8,}\b/g,
    /\bghp_[A-Za-z0-9_]{8,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
    /\bhf_[A-Za-z0-9_]{8,}\b/g,
    /\bglpat-[A-Za-z0-9-]{8,}\b/g,
    /\bpk_live_[A-Za-z0-9_]{8,}\b/g,
    /\brk_live_[A-Za-z0-9_]{8,}\b/g,
    /\btok_[A-Za-z0-9._-]{8,}\b/g,
    /\bkey_[A-Za-z0-9._-]{8,}\b/g,
  ]

  /**
   * Long-form token matcher used by SmartAllow evidence redaction: stricter
   * minimum lengths plus a generic high-entropy catch-all.
   */
  export function longForm(): RegExp {
    return /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|[A-Za-z0-9+/=_-]{48,})\b/g
  }

  export const authSchemes: readonly [RegExp, string][] = [
    [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]"],
    [/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]"],
    [/(Digest\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]"],
  ]

  export const keyValue = /(?<=(token|secret|password|authorization|api[_-]?key|cookie)[:=])\s*[^\s"'&]+/gi

  export const queryParam = /([?&](?:token|secret|password|authorization|api[_-]?key|cookie)=)[^&#\s"']+/gi

  /** Replace every standalone token match; returns the text and match count. */
  export function replaceStandalone(text: string, replacement: string): { text: string; matches: number } {
    let matches = 0
    let result = text
    for (const pattern of standalone) {
      result = result.replace(pattern, () => {
        matches++
        return replacement
      })
    }
    return { text: result, matches }
  }

  export interface Detection {
    value: string
    index: number
  }

  /** Detect standalone token-shaped values without rewriting the text. */
  export function detect(text: string): Detection[] {
    const found: Detection[] = []
    for (const pattern of standalone) {
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        found.push({ value: match[0], index: match.index })
      }
      pattern.lastIndex = 0
    }
    return found
  }
}
