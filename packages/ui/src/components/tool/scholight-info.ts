import { parseToolResultRows, toolCompactArgs, toolFirstString, toolHostname } from "./anysearch-info"

const SCHOLIGHT_ICON = "graduation-cap"

export const SCHOLIGHT_TOOL_NAMES = ["mcp__scholight__search_papers", "mcp__scholight__extract_url"] as const

export type ScholightToolName = (typeof SCHOLIGHT_TOOL_NAMES)[number]

export interface ScholightToolInfo {
  icon: string
  title: string
  subtitle?: string
  args?: string[]
}

export function isScholightToolName(value: string): value is ScholightToolName {
  return (SCHOLIGHT_TOOL_NAMES as readonly string[]).includes(value)
}

function stringList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
  return items.length ? items.join(", ") : undefined
}

function strengthLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const strength = value.trim().toLowerCase()
  return strength === "standard" || strength === "thorough" ? strength : undefined
}

function dateRange(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  // The input carries a single recency date; surfaces it verbatim.
  return value.trim()
}

export function getScholightToolInfo(name: ScholightToolName, input: Record<string, unknown> = {}): ScholightToolInfo {
  switch (name) {
    case "mcp__scholight__search_papers":
      return {
        icon: SCHOLIGHT_ICON,
        title: "Scholight",
        subtitle: toolFirstString(input.query),
        args: toolCompactArgs([
          strengthLabel(input.strength),
          stringList(input.categories),
          stringList(input.authors),
          typeof input.limit === "number" ? `${input.limit} papers` : undefined,
          dateRange(toolFirstString(input.start_date, input.end_date, input.dateRange)),
        ]),
      }
    case "mcp__scholight__extract_url":
      return {
        icon: "file-text",
        title: "Scholight Extract",
        subtitle: toolFirstString(input.url),
        args: toolCompactArgs([toolHostname(input.url), toolFirstString(input.format)]),
      }
  }
}

/** Papers found by search_papers, when the output parses into a paper list. */
export function parseScholightPapers(output: string | undefined) {
  return parseToolResultRows(output)
}
