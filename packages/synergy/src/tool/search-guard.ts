import type { MessageV2 } from "@/session/message-v2"

export namespace SearchGuard {
  export const REFLECTION_MARKER = "[Search failure reflection]"
  export const EARLY_STOP_MARKER = "[Search early stop]"

  export const SEARCH_TOOLS = new Set(["websearch", "arxiv_search", "webfetch", "arxiv_download"])

  export type FailureType =
    | "no_results"
    | "http_403"
    | "http_404"
    | "timeout"
    | "blocked_or_unavailable"
    | "low_quality_results"
    | "duplicate_query"

  export interface SearchRecord {
    tool: string
    query?: string
    domain?: string
    failureType?: FailureType
    error?: string
  }

  export interface FailurePattern {
    type: "reflection" | "early_stop"
    category: string
    failures: SearchRecord[]
    dominant: FailureType | undefined
    hasSimilarQueries: boolean
    domainSummary?: string
  }

  const recentSearches = new Map<string, string[]>()
  const MAX_RECENT_SEARCHES = 50

  export function reset() {
    recentSearches.clear()
  }

  export function normalizeQuery(query: string | undefined): string {
    return (query ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  }

  export function extractQuery(tool: string, input: any): string | undefined {
    if (!input || typeof input !== "object") return undefined
    if (tool === "websearch" && typeof input.query === "string") return input.query
    if (tool === "webfetch" && typeof input.url === "string") return input.url
    if (tool === "arxiv_download" && typeof input.arxivId === "string") return input.arxivId
    if (tool === "arxiv_search") {
      if (typeof input.query === "string" && input.query.trim()) return input.query
      if (Array.isArray(input.titleKeywords) && input.titleKeywords.length) return input.titleKeywords.join(" ")
      if (Array.isArray(input.authors) && input.authors.length) return input.authors.join(" ")
      if (Array.isArray(input.categories) && input.categories.length) return input.categories.join(" ")
    }
    return undefined
  }

  export function extractDomain(input: any): string | undefined {
    if (!input || typeof input !== "object" || typeof input.url !== "string") return undefined
    try {
      return new URL(input.url).hostname.replace(/^www\./, "")
    } catch {
      return undefined
    }
  }

  export function signature(tool: string, input: any): string | undefined {
    const query = normalizeQuery(extractQuery(tool, input))
    if (!query) return undefined

    const filters: Record<string, unknown> = {}
    for (const key of [
      "categories",
      "startDate",
      "endDate",
      "titleKeywords",
      "authors",
      "timeRange",
      "language",
      "numResults",
      "topK",
      "format",
    ]) {
      if (input?.[key] !== undefined) filters[key] = input[key]
    }

    return `${tool}:${query}:${JSON.stringify(filters)}`
  }

  export function checkDuplicate(sessionID: string, tool: string, input: any) {
    const key = signature(tool, input)
    if (!key) return undefined
    const recent = recentSearches.get(sessionID) ?? []
    if (!recent.includes(key)) return undefined

    return {
      query: extractQuery(tool, input) ?? "",
      output: [
        "Search skipped: this exact query and filter set was already tried in this session.",
        "",
        `Tool: ${tool}`,
        `Query: ${extractQuery(tool, input) ?? "(empty)"}`,
        "",
        "Reflect before trying again: broaden or narrow the query, change the source, remove stale filters, or explain why the repeated search is necessary.",
      ].join("\n"),
    }
  }

  export function recordAttempt(sessionID: string, tool: string, input: any) {
    const key = signature(tool, input)
    if (!key) return
    const recent = recentSearches.get(sessionID) ?? []
    recent.push(key)
    recentSearches.set(sessionID, recent.slice(-MAX_RECENT_SEARCHES))
  }

  export function classifyHttpStatus(status: number): FailureType | undefined {
    if (status === 403) return "http_403"
    if (status === 404) return "http_404"
    if (status === 408 || status === 429 || status >= 500) return "blocked_or_unavailable"
    return undefined
  }

  export function classifyError(error: string): FailureType | undefined {
    const text = error.toLowerCase()
    if (/\b403\b/.test(text) || text.includes("forbidden")) return "http_403"
    if (/\b404\b/.test(text) || text.includes("not found")) return "http_404"
    if (text.includes("timed out") || text.includes("timeout") || text.includes("aborterror")) return "timeout"
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

  export function classifyCompleted(part: MessageV2.ToolPart): FailureType | undefined {
    if (part.state.status !== "completed") return undefined
    const metadata = part.state.metadata ?? {}
    if (typeof metadata.searchFailureType === "string") return metadata.searchFailureType as FailureType
    const output = part.state.output.toLowerCase()
    if (output.includes("no search results found") || output.includes("no papers found matching")) return "no_results"
    if (output.includes("search skipped: this exact query")) return "duplicate_query"
    if (output.includes("search quality warning")) return "low_quality_results"
    return undefined
  }

  export function buildRecord(part: MessageV2.ToolPart): SearchRecord | undefined {
    if (!SEARCH_TOOLS.has(part.tool)) return undefined
    const query = extractQuery(part.tool, part.state.input)
    const domain = extractDomain(part.state.input)
    if (part.state.status === "error") {
      return {
        tool: part.tool,
        query,
        domain,
        error: part.state.error,
        failureType: classifyError(part.state.error) ?? "blocked_or_unavailable",
      }
    }
    if (part.state.status === "completed") {
      return {
        tool: part.tool,
        query,
        domain,
        failureType: classifyCompleted(part),
      }
    }
    return undefined
  }

  export function trailingFailures(records: SearchRecord[]): SearchRecord[] {
    const failures: SearchRecord[] = []
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]
      if (!record.failureType) break
      failures.unshift(record)
    }
    return failures
  }

  export function hasSimilarQueries(records: SearchRecord[]): boolean {
    const seen: string[] = []
    for (const record of records) {
      const normalized = normalizeQuery(record.query)
      if (!normalized) continue
      if (seen.some((item) => item === normalized || jaccard(item, normalized) >= 0.85)) return true
      seen.push(normalized)
    }
    return false
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

  export function advice(type: FailureType): string {
    switch (type) {
      case "no_results":
        return "Broaden the query: remove overly specific terms, widen date/category filters, or search background terminology first."
      case "http_403":
        return "Do not keep hitting the same domain or URL. Treat it as restricted access and switch to an official API, mirror, or broader source search."
      case "http_404":
        return "Treat the URL as stale. Search for the title, canonical page, sitemap, or the site's current navigation path."
      case "timeout":
        return "Simplify the query or fetch target and avoid long/complex requests before retrying."
      case "blocked_or_unavailable":
        return "The service or domain may be unavailable, rate-limited, or blocked. Switch source or report the limitation."
      case "low_quality_results":
        return "The result appears thin or off-target. Add key entities or source qualifiers such as paper, project, repository, docs, or github."
      case "duplicate_query":
        return "Do not repeat the same query. Change keywords, filters, or source before searching again."
    }
  }

  function jaccard(a: string, b: string): number {
    const left = new Set(a.split(" ").filter(Boolean))
    const right = new Set(b.split(" ").filter(Boolean))
    if (!left.size || !right.size) return 0
    let intersection = 0
    for (const token of left) {
      if (right.has(token)) intersection++
    }
    return intersection / (left.size + right.size - intersection)
  }
}

// ─── Tool failure pattern detection (issue #29) ────────────────────
//
// Generic framework for detecting tool-category-specific failure patterns.
// Each category (search, file, shell, ...) registers an analyzer that the
// loop signal layer queries. This keeps domain knowledge out of loop-signals.

export interface ToolFailureAnalyzer {
  /** Unique category identifier, e.g. "search". */
  category: string
  /** Tool names that belong to this category. */
  tools: Set<string>
  /** If set, restrict detection to these agent names. */
  agentFilter?: string[]
  /** Threshold of consecutive failures before reflection. */
  reflectionThreshold: number
  /** Threshold of consecutive failures before early stop (must be > reflectionThreshold). */
  earlyStopThreshold: number
  /** Marker text used to detect if reflection has already been injected. */
  reflectionMarker: string
  /** Marker text used to detect if early stop has already been injected. */
  earlyStopMarker: string
  /** Build a failure pattern from a set of consecutive failures. Returns null if no pattern. */
  detect(failures: SearchGuard.SearchRecord[]): SearchGuard.FailurePattern | null
  /** Build an intervention message injected before the next model call. */
  buildIntervention(pattern: SearchGuard.FailurePattern): string
}

function formatDomainSummaryForPattern(failures: SearchGuard.SearchRecord[]): string | undefined {
  const byDomain = new Map<string, Map<string, number>>()
  for (const failure of failures) {
    if (!failure.domain || !failure.failureType) continue
    const counts = byDomain.get(failure.domain) ?? new Map<string, number>()
    counts.set(failure.failureType, (counts.get(failure.failureType) ?? 0) + 1)
    byDomain.set(failure.domain, counts)
  }
  if (byDomain.size === 0) return undefined
  return [...byDomain.entries()]
    .map(([domain, counts]) => {
      const summary = [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(", ")
      return `- ${domain}: ${summary}`
    })
    .join("\n")
}

function dominantFailureTypeForPattern(failures: SearchGuard.SearchRecord[]): SearchGuard.FailureType | undefined {
  const counts = new Map<SearchGuard.FailureType, number>()
  for (const failure of failures) {
    if (!failure.failureType) continue
    counts.set(failure.failureType, (counts.get(failure.failureType) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function formatFailuresForPattern(failures: SearchGuard.SearchRecord[]): string {
  return failures
    .map((failure) => {
      const target = failure.query ?? failure.domain ?? "(unknown target)"
      const domain = failure.domain ? ` domain=${failure.domain}` : ""
      return `- ${failure.tool}: ${target} -> ${failure.failureType ?? "unknown"}${domain}`
    })
    .join("\n")
}

/**
 * Scholar search failure analyzer.
 *
 * Detects patterns of consecutive failed search/fetch tool calls by a
 * scholar agent. Two-stage escalation via loop signals:
 *   - ≥2 consecutive failures → "reflection": injected as a steer message
 *     asking the agent to adjust its search strategy.
 *   - ≥4 consecutive failures → "early_stop": injected as a steer message
 *     instructing the agent to stop searching and report findings.
 */
export const SearchFailureAnalyzer: ToolFailureAnalyzer = {
  category: "search",
  tools: SearchGuard.SEARCH_TOOLS,
  agentFilter: ["scholar"],
  reflectionThreshold: 2,
  earlyStopThreshold: 4,
  reflectionMarker: SearchGuard.REFLECTION_MARKER,
  earlyStopMarker: SearchGuard.EARLY_STOP_MARKER,

  detect(failures) {
    if (failures.length < this.reflectionThreshold) return null

    const dominant = dominantFailureTypeForPattern(failures)
    const type = failures.length >= this.earlyStopThreshold ? "early_stop" : "reflection"

    return {
      type,
      category: this.category,
      failures,
      dominant,
      hasSimilarQueries: SearchGuard.hasSimilarQueries(failures),
      domainSummary: formatDomainSummaryForPattern(failures),
    }
  },

  buildIntervention(pattern) {
    const dominant = pattern.dominant ?? "blocked_or_unavailable"

    if (pattern.type === "early_stop") {
      return [
        this.earlyStopMarker,
        `Scholar search has continued to fail after reflection (${pattern.failures.length} consecutive failed or unusable search/fetch attempts).`,
        "",
        "Stop calling search tools for this turn unless the user explicitly asks for more attempts.",
        "",
        "Return the best available conclusion now. Include:",
        "- the queries or URLs already tried",
        "- the main failure types observed",
        "- your current diagnosis",
        "- a concrete next step the user can take, such as using a different source, API, exact title, or manual browser access",
        "",
        "Recent failed attempts:",
        formatFailuresForPattern(pattern.failures),
        ...(pattern.domainSummary ? ["", "Domain failure summary:", pattern.domainSummary] : []),
        "",
        `Main failure type: ${dominant}`,
        `Likely next move: ${SearchGuard.advice(dominant)}`,
      ].join("\n")
    }

    return [
      this.reflectionMarker,
      `The last ${pattern.failures.length} scholar search/fetch attempts failed or produced unusable results.`,
      "",
      "Recent failed attempts:",
      formatFailuresForPattern(pattern.failures),
      ...(pattern.domainSummary ? ["", "Domain failure summary:", pattern.domainSummary] : []),
      "",
      `Dominant failure type: ${dominant}`,
      `Adjustment advice: ${SearchGuard.advice(dominant)}`,
      pattern.hasSimilarQueries
        ? "Repeated or very similar queries were detected. Do not repeat the same query; rewrite it or switch source."
        : "Before searching again, change the query or source based on the failure type.",
      "",
      "Reflect briefly before the next tool call: classify the failure, explain the strategy change, then either try one meaningfully different query/source or stop and report the limitation.",
    ].join("\n")
  },
}

/** Registry of active tool failure analyzers. */
const failureAnalyzers = new Map<string, ToolFailureAnalyzer>()

export function registerFailureAnalyzer(analyzer: ToolFailureAnalyzer) {
  failureAnalyzers.set(analyzer.category, analyzer)
}

export function getFailureAnalyzers(): ReadonlyMap<string, ToolFailureAnalyzer> {
  return failureAnalyzers
}

// Register the built-in search analyzer by default.
registerFailureAnalyzer(SearchFailureAnalyzer)
