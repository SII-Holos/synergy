import z from "zod"
import DESCRIPTION from "./view-file.txt"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import {
  assertInsideOrAsk,
  DEFAULT_VIEW_BYTES,
  DEFAULT_VIEW_LINES,
  displayPath,
  formatRecordedBlock,
  formatSelectedLines,
  markFileRead,
  normalizeLineLimit,
  readTextFile,
  readTextFileUnderSnapshotCap,
  resolveFilePath,
  splitDisplayLines,
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

function formatLineRange(
  lines: string[],
  offset: number,
  limit: number,
): { body: string; truncated: boolean; endLine: number; truncatedLines: number[] } {
  const shown = lines.slice(offset, offset + limit)
  const lineNumbers = shown.map((_, index) => offset + index + 1)
  const formatted = formatSelectedLines(lines, lineNumbers)
  return {
    body: formatted.output,
    truncated: offset + shown.length < lines.length || formatted.truncatedLines.length > 0,
    endLine: offset + shown.length,
    truncatedLines: formatted.truncatedLines,
  }
}

function cappedPreviewMessage(filePath: string): string {
  return [
    `[Large file: ${displayPath(filePath)} is too large for anchored editing in one call.]`,
    "Only the beginning of the file is displayed. No [path#TAG] header is returned, so revise_file cannot use this output directly.",
    "Use scan_files or a narrower view_file range after locating the relevant lines.",
  ].join("\n")
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
    await assertInsideOrAsk(filePath, ctx)
    await ctx.ask({ permission: "view_file", patterns: [filePath], metadata: {} })

    let content = await readTextFileUnderSnapshotCap(filePath)
    const snapshotAvailable = content !== undefined
    if (content === undefined) {
      const file = Bun.file(filePath)
      content = await file.slice(0, DEFAULT_VIEW_BYTES).text()
    }

    const fullContentForConflict = snapshotAvailable ? content : await readTextFile(filePath).catch(() => content)
    const tag = snapshotAvailable ? formatRecordedBlock(ctx.sessionID, filePath, content).tag : undefined
    markFileRead(ctx.sessionID, filePath)
    LSP.touchFile(filePath, false)

    const lines = splitDisplayLines(content)
    const display = displayPath(filePath)
    const conflict = detectConflicts(fullContentForConflict)
    const warning = conflictWarning(conflict)
    const header = tag ? `[${display}#${tag}]` : cappedPreviewMessage(filePath)

    const emptyRangeMetadata: RangeMetadata[] = []
    if (params.ranges) {
      const blocks: string[] = []
      const rangeMetadata: RangeMetadata[] = params.ranges.map((range, index) => {
        const limit = normalizeLineLimit(range.limit)
        const formatted = formatLineRange(lines, range.offset, limit)
        if (formatted.body)
          blocks.push(`## Range ${index + 1}: lines ${range.offset + 1}-${formatted.endLine}\n${formatted.body}`)
        return {
          offset: range.offset,
          limit,
          startLine: range.offset + 1,
          endLine: formatted.endLine,
          truncated: formatted.truncated,
          truncatedLines: formatted.truncatedLines,
        }
      })
      const outputParts = [warning, header, ...blocks].filter(Boolean)
      return {
        title: display,
        output: `${outputParts.join("\n")}${blocks.length ? "" : "\n"}`,
        metadata: {
          path: display,
          tag,
          totalLines: lines.length,
          ranges: rangeMetadata,
          offset: undefined as number | undefined,
          limit: undefined as number | undefined,
          truncated: !snapshotAvailable || rangeMetadata.some((range) => range.truncated),
          truncatedLines: rangeMetadata.flatMap((range) => range.truncatedLines),
          snapshotAvailable,
          hasConflicts: conflict.hasConflicts,
          conflicts: conflict.conflicts,
        },
      }
    }

    const offset = params.offset ?? 0
    const limit = normalizeLineLimit(params.limit, DEFAULT_VIEW_LINES)
    const formatted = formatLineRange(lines, offset, limit)
    const output = `${[warning, header, formatted.body].filter(Boolean).join("\n")}${formatted.body ? "" : "\n"}`

    return {
      title: display,
      output,
      metadata: {
        path: display,
        tag,
        offset,
        limit,
        ranges: emptyRangeMetadata,
        totalLines: lines.length,
        truncated: !snapshotAvailable || formatted.truncated,
        truncatedLines: formatted.truncatedLines,
        snapshotAvailable,
        hasConflicts: conflict.hasConflicts,
        conflicts: conflict.conflicts,
      },
    }
  },
})
