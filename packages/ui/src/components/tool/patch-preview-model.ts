import { highlightInputAllowed } from "../../pierre/cache-budget"
import { parseRenderablePatch } from "../diff-patch-utils"
import { previewToolContent, TOOL_PREVIEW_LINES } from "./content-preview-model"

export function toolPatchPreview(patch: string, path?: string) {
  const parsed = highlightInputAllowed(patch) ? parseRenderablePatch(patch) : undefined
  const rows: Array<{ kind: "context" | "add" | "delete"; number: number; text: string; gap: boolean }> = []
  if (!parsed) return { rows, truncated: !!patch && !highlightInputAllowed(patch) }
  for (const hunk of parsed.hunks) {
    const firstRow = rows.length
    for (const block of hunk.hunkContent) {
      const kinds = block.type === "context" ? ["context" as const] : ["delete" as const, "add" as const]
      for (const kind of kinds) {
        const count = block.type === "context" ? block.lines : kind === "delete" ? block.deletions : block.additions
        const start = kind === "delete" ? block.deletionLineIndex : block.additionLineIndex
        const base =
          kind === "delete" ? hunk.deletionStart - hunk.deletionLineIndex : hunk.additionStart - hunk.additionLineIndex
        for (let offset = 0; offset < count && rows.length < TOOL_PREVIEW_LINES; offset++) {
          const text = (kind === "delete" ? parsed.deletionLines : parsed.additionLines)[start + offset] ?? ""
          rows.push({
            kind,
            number: base + start + offset,
            text: text.replace(/\r?\n$/, ""),
            gap: rows.length === firstRow && hunk.collapsedBefore > 0,
          })
        }
      }
    }
    if (rows.length === TOOL_PREVIEW_LINES) break
  }
  const bounded = previewToolContent(rows.map((row) => row.text).join("\n"))
  return {
    metadata: bounded.truncated ? undefined : { ...parsed, name: path || parsed.name },
    rows: bounded.truncated ? bounded.text.split("\n").map((text, index) => ({ ...rows[index], text })) : rows,
    changes: {
      additions: parsed.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: parsed.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
    },
    truncated: bounded.truncated || parsed.hunks.reduce((sum, hunk) => sum + hunk.unifiedLineCount, 0) > rows.length,
  }
}
