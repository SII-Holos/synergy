const ANYSEARCH_ICON = "orbit"

export const ANYSEARCH_TOOL_NAMES = [
  "mcp__anysearch__search",
  "mcp__anysearch__batch_search",
  "mcp__anysearch__extract",
  "mcp__anysearch__get_sub_domains",
] as const

export type AnysearchToolName = (typeof ANYSEARCH_TOOL_NAMES)[number]

export interface AnysearchToolInfo {
  icon: typeof ANYSEARCH_ICON
  title: string
  subtitle?: string
  args?: string[]
}

export function isAnysearchToolName(value: string): value is AnysearchToolName {
  return (ANYSEARCH_TOOL_NAMES as readonly string[]).includes(value)
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function firstQuery(input: Record<string, unknown>) {
  const queries = input.queries
  if (!Array.isArray(queries)) return firstString(input.query)
  for (const item of queries) {
    if (typeof item === "string") return item
    if (item && typeof item === "object") {
      const query = firstString((item as Record<string, unknown>).query)
      if (query) return query
    }
  }
  return undefined
}

function queryCount(input: Record<string, unknown>) {
  return Array.isArray(input.queries) ? input.queries.length : undefined
}

function routeLabels(input: Record<string, unknown>) {
  const result = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) result.add(value.trim())
  }

  add(input.domain)
  add(input.sub_domain)
  if (Array.isArray(input.domains)) {
    for (const domain of input.domains) add(domain)
  }
  if (Array.isArray(input.queries)) {
    for (const item of input.queries) {
      if (!item || typeof item !== "object") continue
      const query = item as Record<string, unknown>
      add(query.domain)
      add(query.sub_domain)
    }
  }

  return [...result]
}

function hostname(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined
  try {
    return new URL(value).hostname
  } catch {
    return value
  }
}

function compactArgs(values: Array<string | undefined>) {
  const result: string[] = []
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : ""
    if (!normalized || result.includes(normalized)) continue
    result.push(normalized)
  }
  return result.length ? result : undefined
}

export function getAnysearchToolInfo(name: AnysearchToolName, input: Record<string, unknown> = {}): AnysearchToolInfo {
  const routeTags = routeLabels(input)
  switch (name) {
    case "mcp__anysearch__search":
      return {
        icon: ANYSEARCH_ICON,
        title: "Anysearch",
        subtitle: firstString(input.query),
        args: compactArgs([
          ...routeTags,
          typeof input.max_results === "number" ? `${input.max_results} results` : undefined,
        ]),
      }
    case "mcp__anysearch__batch_search": {
      const count = queryCount(input)
      return {
        icon: ANYSEARCH_ICON,
        title: "Anysearch Batch",
        subtitle: count ? `${count} parallel searches` : firstQuery(input),
        args: compactArgs([count ? `${count} queries` : undefined, ...routeTags.slice(0, 3)]),
      }
    }
    case "mcp__anysearch__extract":
      return {
        icon: ANYSEARCH_ICON,
        title: "Anysearch Extract",
        subtitle: firstString(input.url),
        args: compactArgs([hostname(input.url), firstString(input.format)]),
      }
    case "mcp__anysearch__get_sub_domains":
      return {
        icon: ANYSEARCH_ICON,
        title: "Search Domains",
        subtitle: routeTags.join(", "),
        args: compactArgs([
          routeTags.length ? `${routeTags.length} domain${routeTags.length === 1 ? "" : "s"}` : undefined,
          "vertical routing",
        ]),
      }
  }
}

// ── Shared defensive parsers for remote MCP search cards ──────────────
// Tool output arrives as text from the server; shapes vary by server and
// version. These helpers return structured rows only when the output parses
// into a recognizable shape, so renderers can fall back to plain text.

function parseJsonOutput(output: string | undefined): unknown | undefined {
  if (!output) return undefined
  const trimmed = output.trim()
  if (!trimmed) return undefined
  const json = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```[a-zA-Z]*\s*/, "")
        .replace(/\s*```$/, "")
        .trim()
    : trimmed
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

export interface ToolResultRow {
  title: string
  meta?: string
  url?: string
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

function labelFrom(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function yearFrom(record: Record<string, unknown>): string | undefined {
  const direct = labelFrom(record, ["year", "published_year", "publication_year", "publishedYear"])
  if (direct) return direct
  for (const key of ["year", "published_year", "publication_year", "publishedYear"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 1000 && value <= 9999) {
      return String(Math.trunc(value))
    }
  }
  for (const key of ["date", "published", "published_at", "publishedAt", "created"]) {
    const value = record[key]
    if (typeof value === "string") {
      const match = /^(19|20)\d{2}/.exec(value.trim())
      if (match) return match[0]
    }
  }
  return undefined
}

function scoreFrom(record: Record<string, unknown>): string | undefined {
  const value = record["score"]
  if (typeof value === "number" && Number.isFinite(value)) return `score ${Number(value.toFixed(2))}`
  if (typeof value === "string" && value.trim()) return `score ${value.trim()}`
  return undefined
}

export function toolResultRowMeta(record: Record<string, unknown>): string | undefined {
  const venue = labelFrom(record, ["venue", "journal", "source", "publisher", "container_title", "conference"])
  const parts = [yearFrom(record), venue, scoreFrom(record)].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

export function parseToolResultRows(output: string | undefined): ToolResultRow[] | undefined {
  const parsed = parseJsonOutput(output)
  if (parsed === undefined) return undefined

  const collect = (value: unknown): ToolResultRow[] => {
    if (typeof value === "string") return value.trim() ? [{ title: value.trim() }] : []
    const record = recordOf(value)
    if (!record) return []
    const title = labelFrom(record, ["title", "name", "heading"])
    if (!title) return []
    return [
      {
        title,
        meta: toolResultRowMeta(record),
        url: labelFrom(record, ["url", "link", "href", "pdf_url"]),
      },
    ]
  }

  let values: unknown[] | undefined
  if (Array.isArray(parsed)) {
    values = parsed
  } else {
    const record = recordOf(parsed)
    for (const key of ["results", "papers", "hits", "items", "documents"]) {
      const nested = record?.[key]
      if (Array.isArray(nested)) {
        values = nested
        break
      }
    }
  }

  if (!values) return undefined
  const rows = values.flatMap(collect)
  return rows.length ? rows : undefined
}

/**
 * Extract per-query numeric result counts from a completed batch_search
 * output. Accepts JSON arrays of numbers, arrays of records carrying
 * count/result fields, and records keyed by query. Returns undefined when
 * the output does not parse into a countable shape.
 */
export function parseToolBatchCounts(output: string | undefined): (number | undefined)[] | undefined {
  const parsed = parseJsonOutput(output)
  if (parsed === undefined) return undefined

  const toCount = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
    if (Array.isArray(value)) return value.length
    const record = recordOf(value)
    if (!record) return undefined
    for (const key of ["count", "result_count", "num_results", "total", "results_count"]) {
      const count = record[key]
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) return count
      if (Array.isArray(count)) return count.length
    }
    if (Array.isArray(record.results)) return record.results.length
    return undefined
  }

  if (Array.isArray(parsed)) return parsed.map(toCount)
  const record = recordOf(parsed)
  if (!record) return undefined
  for (const key of ["counts", "results"]) {
    const value = record[key]
    if (Array.isArray(value)) return value.map(toCount)
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).map(([, count]) => toCount(count))
    }
  }
  const direct = toCount(record)
  return direct === undefined ? undefined : [direct]
}

export function toolQueryList(input: Record<string, unknown>): string[] {
  const queries = input.queries
  if (!Array.isArray(queries)) {
    const query = firstString(input.query)
    return query ? [query] : []
  }
  const result: string[] = []
  for (const item of queries) {
    const query = typeof item === "string" ? firstString(item) : firstString((item as Record<string, unknown>).query)
    if (query && !result.includes(query)) result.push(query)
  }
  return result
}

export function toolDomainLabels(input: Record<string, unknown>): string[] {
  return routeLabels(input)
}

export function toolHostname(value: unknown): string | undefined {
  return hostname(value)
}

export function toolCompactArgs(values: Array<string | undefined>): string[] | undefined {
  return compactArgs(values)
}

export function toolFirstString(...values: unknown[]): string | undefined {
  return firstString(...values)
}

export function toolElapsedLabel(time: { start?: number; end?: number } | null | undefined): string | undefined {
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return undefined
  const ms = Math.max(0, time.end - time.start)
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return seconds < 10 ? `${Math.round(seconds * 10) / 10}s` : `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`
}

export interface BatchSearchViewRow {
  query: string
  count?: number
}

export interface BatchSearchView {
  queries: string[]
  pending: boolean
  /** Per-query rows with parsed result counts; present when completed and the
   * output parses into a countable shape. */
  rows?: BatchSearchViewRow[]
  /** Completed but the output did not parse into counts — text fallback. */
  raw?: boolean
  total?: number
  elapsed?: string
}

/** Pure view-model for the batch_search (C) card body. */
export function batchSearchView(
  input: Record<string, unknown>,
  output: string | undefined,
  time: { start?: number; end?: number } | null | undefined,
  status: string | undefined,
): BatchSearchView {
  const queries = toolQueryList(input)
  const pending = status === "pending" || status === "running" || status === "generating"
  const elapsed = toolElapsedLabel(time)
  if (pending) return { queries, pending, elapsed }
  const counts = parseToolBatchCounts(output)
  if (!counts) return { queries, pending: false, raw: true, elapsed }
  const rows = queries.map((query, index) => ({ query, count: counts[index] }))
  const total = counts.reduce<number>((acc, count) => acc + (typeof count === "number" ? count : 0), 0)
  return { queries, pending: false, rows, total, elapsed }
}
