import type { FileDiff, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import type { ToolReviewTarget } from "@ericsanchezok/synergy-ui/context/resource-open"

export function toolReviewSource(target: ToolReviewTarget) {
  return `tool:${JSON.stringify([target.sessionID, target.messageID, target.partID])}`
}

export function parseToolReviewSource(source?: string): ToolReviewTarget | undefined {
  if (!source?.startsWith("tool:")) return undefined
  try {
    const value: unknown = JSON.parse(source.slice(5))
    if (!Array.isArray(value) || value.length !== 3 || !value.every((id) => typeof id === "string" && id.length > 0))
      return undefined
    return { sessionID: value[0], messageID: value[1], partID: value[2] }
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function toolReviewDiffs(part: ToolPart, path?: string): FileDiff[] {
  const metadata = record(part.state.metadata)
  const values = Array.isArray(metadata.results) ? metadata.results : [metadata]
  const diffs = values.flatMap((value): FileDiff[] => {
    const item = record(value)
    const diff = record(item.filediff)
    const patch = [item.diff, diff.patch, diff.preview].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    if (!patch) return []
    return [
      {
        file: typeof diff.file === "string" ? diff.file : path || "file",
        additions: typeof diff.additions === "number" ? diff.additions : 0,
        deletions: typeof diff.deletions === "number" ? diff.deletions : 0,
        patch,
        preview: patch,
        ...(diff.truncated === true ? { truncated: true } : {}),
      },
    ]
  })
  const groups = new Map<string, FileDiff[]>()
  for (const diff of diffs) {
    const group = groups.get(diff.file)
    if (group) group.push(diff)
    else groups.set(diff.file, [diff])
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!
    if (group.length === 1) return first
    const patch = group.map((diff) => diff.patch).join("\n")
    return {
      ...first,
      patch,
      preview: patch,
      additions: group.reduce((total, diff) => total + diff.additions, 0),
      deletions: group.reduce((total, diff) => total + diff.deletions, 0),
      truncated: group.some((diff) => diff.truncated),
    }
  })
}
