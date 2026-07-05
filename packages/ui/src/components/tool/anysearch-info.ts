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
