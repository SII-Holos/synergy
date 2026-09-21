import z from "zod"
import DESCRIPTION from "./view-file.txt"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolLspSource } from "@ericsanchezok/synergy-harness/tool/lsp-source"
import { SessionBounds } from "@ericsanchezok/synergy-harness/session/bounds"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import {
  DEFAULT_VIEW_BYTES,
  DEFAULT_VIEW_LINES,
  displayPath,
  recordHashlineSnapshot,
  OutputBudget,
  selectDisplayLines,
  markFileRead,
  normalizeLineLimit,
  readTextFileUnderSnapshotCap,
  resolveFilePath,
  splitDisplayLines,
  recordSeenSessionLines,
} from "./anchored-file"

const RangeSchema = z.object({
  offset: z.coerce.number().int().min(0).describe("The 0-based line offset for this displayed range"),
  limit: z.coerce.number().int().min(0).optional().describe("The number of lines to display for this range"),
})

interface RangeMetadata {
  offset: number
  limit: number
  startLine: number
  endLine: number
  truncated: boolean
  truncatedLines: number[]
}

function cappedPreviewMessage(filePath: string): string {
  return [
    `[Large file: ${displayPath(filePath)} is too large for anchored editing in one call.]`,
    "Only the beginning of the file is displayed. No [path#TAG] header is returned, so revise_file cannot use this output directly.",
    "The snapshot limit applies to the whole file regardless of range. Use bounded shell reads or classic read for later regions; anchored editing is unavailable.",
  ].join("\n")
}

function viewContent(snapshotAvailable: boolean, content: string): string | undefined {
  if (!snapshotAvailable) return undefined
  // Cap the UI-only content at a fraction of the snapshot cap so large
  // but snapshotable files do not permanently bloat the session JSON.
  if (SessionBounds.byteLength(content) > SessionBounds.VIEW_CONTENT_MAX_BYTES) return undefined
  return content
}

export const ViewFileTool = Tool.define("view_file", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to view and prepare for anchored editing"),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .describe("The 0-based line offset to display; use this to inspect unseen ranges before revise_file")
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(0)
      .describe("The number of lines to display; use ranges or another view_file call for hidden regions")
      .optional(),
    ranges: z.array(RangeSchema).optional().describe("Optional non-contiguous ranges to display from the same file"),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    await ctx.ask({ permission: "view_file", patterns: [filePath], metadata: {} })

    let content = await readTextFileUnderSnapshotCap(filePath)
    const snapshotAvailable = content !== undefined
    if (content === undefined) {
      const file = Bun.file(filePath)
      const prefix = await file.slice(0, DEFAULT_VIEW_BYTES).text()
      content = prefix.slice(0, prefix.lastIndexOf("\n") + 1)
    }

    const tag = snapshotAvailable ? recordHashlineSnapshot(ctx.sessionID, filePath, content) : undefined
    markFileRead(ctx.sessionID, filePath)
    void ToolLspSource.get()?.touchFile(filePath, false)

    const lines = splitDisplayLines(content)
    const display = displayPath(filePath)
    const conflict = detectConflicts(content)
    const warning = conflictWarning(conflict)
    const header = tag ? `[${display}#${tag}]` : cappedPreviewMessage(filePath)

    const budget = new OutputBudget()
    const displayed = new Set<number>()
    const requested = params.ranges ?? [{ offset: params.offset ?? 0, limit: params.limit }]
    const blocks: string[] = []
    const rangeMetadata: RangeMetadata[] = []
    const continuations: string[] = []
    for (const [index, range] of requested.entries()) {
      const limit = normalizeLineLimit(range.limit)
      const end = Math.min(lines.length, range.offset + limit)
      const numbers = Array.from({ length: Math.max(0, end - range.offset) }, (_, i) => range.offset + i + 1)
      const selected = selectDisplayLines(lines, numbers, budget, displayed)
      const endLine = selected.seen.at(-1) ?? Math.min(range.offset, lines.length)
      const nextLine = selected.omitted[0] ?? (end < lines.length ? end + 1 : undefined)
      if (selected.output) {
        blocks.push(
          params.ranges
            ? `## Range ${index + 1}: lines ${selected.seen[0]}-${endLine}\n${selected.output}`
            : selected.output,
        )
      }
      if (snapshotAvailable && limit > 0 && nextLine !== undefined && continuations.length < 8) {
        const oversized = Buffer.byteLength(`${nextLine}:${lines[nextLine - 1]}`, "utf8") > DEFAULT_VIEW_BYTES
        continuations.push(
          oversized
            ? `Line ${nextLine} exceeds the ${DEFAULT_VIEW_BYTES}-byte budget; inspect it with a bounded shell command. It is not an editable displayed line.`
            : `Continue range ${index + 1} with offset=${nextLine - 1}, limit=${Math.max(1, Math.min(limit || DEFAULT_VIEW_LINES, lines.length - nextLine + 1))}.`,
        )
      }
      rangeMetadata.push({
        offset: range.offset,
        limit,
        startLine: selected.seen[0] ?? range.offset + 1,
        endLine,
        truncated: nextLine !== undefined,
        truncatedLines: selected.omitted.slice(0, 1),
      })
    }
    if (tag) recordSeenSessionLines(ctx.sessionID, filePath, [...displayed], tag)
    const output = [warning, header, ...blocks, ...continuations].filter(Boolean).join("\n")
    const primary = rangeMetadata[0]
    return {
      title: display,
      output: `${output}${blocks.length ? "" : "\n"}`,
      metadata: {
        path: display,
        tag,
        offset: params.ranges ? undefined : primary?.offset,
        limit: params.ranges ? undefined : primary?.limit,
        ranges: params.ranges ? rangeMetadata : [],
        totalLines: snapshotAvailable ? lines.length : undefined,
        prefixLines: snapshotAvailable ? undefined : lines.length,
        conflictsPartial: !snapshotAvailable,
        truncated: !snapshotAvailable || rangeMetadata.some((range) => range.truncated),
        truncatedLines: rangeMetadata.flatMap((range) => range.truncatedLines),
        snapshotAvailable,
        content: viewContent(snapshotAvailable, content),
        hasConflicts: conflict.hasConflicts,
        conflicts: conflict.conflicts,
      },
    }
  },
})
