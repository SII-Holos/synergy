import { RuntimeContext } from "../lifecycle/context"
import { Identifier } from "../id/id"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import type { Tool } from "./tool"

export namespace SearchGuard {
  export const REFLECTION_MARKER = "[Search failure reflection]"
  export const EARLY_STOP_MARKER = "[Search early stop]"

  export const SEARCH_TOOLS = new Set(["webfetch"])

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
    signature?: string
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

  export function normalizeQuery(query: string | undefined): string {
    return (query ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  }

  function objectInput(input: unknown): Record<string, unknown> | undefined {
    return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  }

  export function extractQuery(_tool: string, input: unknown): string | undefined {
    const value = objectInput(input)
    if (!value) return undefined
    for (const key of ["query", "url", "arxivId"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key]
    }
    for (const key of ["titleKeywords", "authors", "categories"]) {
      const list = value[key]
      if (Array.isArray(list) && list.length && list.every((item) => typeof item === "string")) return list.join(" ")
    }
    return undefined
  }

  export function extractDomain(input: unknown): string | undefined {
    const value = objectInput(input)
    if (typeof value?.url !== "string") return undefined
    try {
      return new URL(value.url).hostname.replace(/^www\./, "")
    } catch {
      return undefined
    }
  }

  export function signature(tool: string, input: unknown): string | undefined {
    const value = objectInput(input)
    const query =
      typeof value?.url === "string" && value.query === undefined
        ? value.url.trim()
        : normalizeQuery(extractQuery(tool, input))
    if (!query) return undefined

    const filters: Record<string, unknown> = {}
    for (const key of Object.keys(value ?? {}).sort()) {
      if (["query", "url", "arxivId", "timeoutSeconds"].includes(key) || value![key] === undefined) continue
      const filter = value![key]
      filters[key] =
        ["categories", "authors", "titleKeywords"].includes(key) &&
        Array.isArray(filter) &&
        filter.every((item) => typeof item === "string")
          ? [...filter].sort()
          : filter
    }

    return `${tool}:${query}:${JSON.stringify(filters)}`
  }

  export function checkDuplicate(records: readonly SearchRecord[], tool: string, input: unknown) {
    const key = signature(tool, input)
    if (!key) return undefined
    if (!records.some((record) => (record.signature ?? signature(record.tool, { query: record.query })) === key))
      return undefined

    return {
      query: extractQuery(tool, input) ?? "",
      output: [
        "Search skipped: this exact query and filter set was already tried in this root task.",
        "",
        `Tool: ${tool}`,
        `Query: ${extractQuery(tool, input) ?? "(empty)"}`,
        "",
        "Reflect before trying again: broaden or narrow the query, change the source, remove stale filters, or explain why the repeated search is necessary.",
      ].join("\n"),
    }
  }

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

  export function classifyCompleted(part: MessageV2.ToolPart): FailureType | undefined {
    if (part.state.status !== "completed") return undefined
    const metadata = part.state.metadata ?? {}
    if (isFailureType(metadata.searchFailureType)) return metadata.searchFailureType
    const output = part.state.output.toLowerCase()
    if (output.includes("no search results") || output.includes("no papers found matching")) return "no_results"
    if (output.includes("search skipped: this exact query")) return "duplicate_query"
    if (output.includes("search quality warning")) return "low_quality_results"
    return undefined
  }

  export function buildRecord(
    part: MessageV2.ToolPart,
    tools: ReadonlySet<string> = SEARCH_TOOLS,
  ): SearchRecord | undefined {
    if (!tools.has(part.tool)) return undefined
    const query = extractQuery(part.tool, part.state.input)
    const domain = extractDomain(part.state.input)
    const key = signature(part.tool, part.state.input)
    if (part.state.status === "error") {
      return {
        tool: part.tool,
        query,
        signature: key,
        domain,
        error: part.state.error,
        failureType: classifyError(part.state.error) ?? "blocked_or_unavailable",
      }
    }
    if (part.state.status === "completed") {
      return {
        tool: part.tool,
        query,
        signature: key,
        domain,
        failureType: classifyCompleted(part),
      }
    }
    return undefined
  }

  export function recordsForRoot(
    messages: readonly MessageV2.WithParts[],
    rootMessageID: string,
    searchTools: ReadonlySet<string> = SEARCH_TOOLS,
  ): SearchRecord[] {
    const canonical = MessageV2.deriveSemantics([...messages])
    const rootIndex = canonical.findIndex((message) => message.info.id === rootMessageID)
    if (rootIndex < 0) return []
    const records: SearchRecord[] = []
    for (const message of canonical.slice(rootIndex + 1)) {
      if (message.info.role === "user" && message.info.isRoot === true) break
      if (message.info.role !== "assistant" || message.info.rootID !== rootMessageID) continue
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const record = buildRecord(part, searchTools)
        if (record) records.push(record)
      }
    }
    return records
  }

  export async function recordsForRootDurable(input: {
    scopeID: string
    sessionID: string
    rootMessageID: string
    searchTools?: ReadonlySet<string>
    signal?: AbortSignal
  }): Promise<SearchRecord[]> {
    const batches: SearchRecord[][] = []
    for await (const raw of MessageV2.readNewestInfos({
      scopeID: Identifier.asScopeID(input.scopeID),
      sessionID: Identifier.asSessionID(input.sessionID),
    })) {
      input.signal?.throwIfAborted()
      const info = MessageV2.Info.parse(raw)
      if (info.id === input.rootMessageID) return batches.toReversed().flat()
      if (info.role === "user" && info.isRoot === true) return []
      if (info.role !== "assistant" || info.rootID !== input.rootMessageID) continue
      const parts = await MessageV2.parts({ scopeID: input.scopeID, sessionID: input.sessionID, messageID: info.id })
      input.signal?.throwIfAborted()
      batches.push(
        parts.flatMap((part) => {
          if (part.type !== "tool") return []
          const record = buildRecord(MessageV2.ToolPart.parse(part), input.searchTools)
          return record ? [record] : []
        }),
      )
    }
    return []
  }

  export async function checkDuplicateForContext(
    context: Pick<Tool.Context, "sessionID" | "messageID" | "abort">,
    tool: string,
    input: unknown,
    searchTools: ReadonlySet<string> = SEARCH_TOOLS,
  ) {
    context.abort.throwIfAborted()
    if (!searchTools.has(tool)) return undefined
    const session = await Session.get(context.sessionID)
    const scopeID = session.scope.id
    const { info } = await MessageV2.get({ scopeID, sessionID: context.sessionID, messageID: context.messageID })
    if (info.role !== "assistant" || !info.rootID)
      throw new Error("Search admission requires a persisted assistant root")
    const root = await MessageV2.get({ scopeID, sessionID: context.sessionID, messageID: info.rootID })
    if (root.info.role !== "user" || root.info.isRoot !== true)
      throw new Error("Search admission requires a persisted user root")
    return checkDuplicate(
      await recordsForRootDurable({
        scopeID,
        sessionID: context.sessionID,
        rootMessageID: info.rootID,
        searchTools,
        signal: context.abort,
      }),
      tool,
      input,
    )
  }

  function isFailureType(value: unknown): value is FailureType {
    return (
      typeof value === "string" &&
      [
        "no_results",
        "http_403",
        "http_404",
        "timeout",
        "blocked_or_unavailable",
        "low_quality_results",
        "duplicate_query",
      ].includes(value)
    )
  }

  export function trailingFailures(records: readonly SearchRecord[]): SearchRecord[] {
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
        `Search has continued to fail after reflection (${pattern.failures.length} consecutive failed or unusable search/fetch attempts).`,
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
      `The last ${pattern.failures.length} search/fetch attempts failed or produced unusable results.`,
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
const runtimeState = RuntimeContext.state(() => ({
  failureAnalyzers: new Map<string, ToolFailureAnalyzer>(),
}))

export function registerFailureAnalyzer(analyzer: ToolFailureAnalyzer) {
  RuntimeContext.assertCompositionOpen("Tool failure analyzers")
  const instanceState = runtimeState()

  instanceState.failureAnalyzers.set(analyzer.category, {
    ...analyzer,
    tools: new Set(analyzer.tools),
    agentFilter: analyzer.agentFilter ? [...analyzer.agentFilter] : undefined,
  })
}

export function getFailureAnalyzers(): ReadonlyMap<string, ToolFailureAnalyzer> {
  const instanceState = runtimeState()

  return instanceState.failureAnalyzers
}

// Register the built-in search analyzer by default.
export function registerSearchFailureAnalyzer() {
  registerFailureAnalyzer(SearchFailureAnalyzer)
}
