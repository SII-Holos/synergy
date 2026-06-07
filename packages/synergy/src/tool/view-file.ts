import z from "zod"
import DESCRIPTION from "./view-file.txt"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  markFileRead,
  readTextFile,
  resolveFilePath,
} from "./anchored-file"

const DEFAULT_READ_LIMIT = 2000

const RangeSchema = z.object({
  offset: z.coerce.number().int().min(0).describe("The 0-based line offset for this displayed range"),
  limit: z.coerce.number().int().min(0).optional().describe("The number of lines to display for this range"),
})

function normalizeLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_READ_LIMIT
}

function formatLineRange(
  lines: string[],
  offset: number,
  limit: number,
): { body: string; truncated: boolean; endLine: number } {
  const shown = lines.slice(offset, offset + limit)
  const body = shown.map((line, index) => `${offset + index + 1}:${line}`).join("\n")
  return {
    body,
    truncated: offset + shown.length < lines.length,
    endLine: offset + shown.length,
  }
}

export const ViewFileTool = Tool.define("view_file", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to view and snapshot for anchored editing"),
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
      .describe("The number of lines to display; the full file is snapshotted even when displayed output is limited")
      .optional(),
    ranges: z
      .array(RangeSchema)
      .optional()
      .describe("Optional non-contiguous ranges to display from the same file snapshot"),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    await assertInsideOrAsk(filePath, ctx)
    await ctx.ask({ permission: "view_file", patterns: [filePath], metadata: {} })

    const content = await readTextFile(filePath)
    const { tag } = formatRecordedBlock(ctx.sessionID, filePath, content)
    markFileRead(ctx.sessionID, filePath)
    LSP.touchFile(filePath, false)

    const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    if (lines.at(-1) === "") lines.pop()

    const display = displayPath(filePath)
    const conflict = detectConflicts(content)
    const warning = conflictWarning(conflict)
    const header = `[${display}#${tag}]`

    const emptyRangeMetadata: Array<{
      offset: number
      limit: number
      startLine: number
      endLine: number
      truncated: boolean
    }> = []
    if (params.ranges) {
      const blocks: string[] = []
      const rangeMetadata = params.ranges.map((range, index) => {
        const limit = normalizeLimit(range.limit)
        const formatted = formatLineRange(lines, range.offset, limit)
        if (formatted.body)
          blocks.push(`## Range ${index + 1}: lines ${range.offset + 1}-${formatted.endLine}\n${formatted.body}`)
        return {
          offset: range.offset,
          limit,
          startLine: range.offset + 1,
          endLine: formatted.endLine,
          truncated: formatted.truncated,
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
          truncated: undefined as boolean | undefined,
          hasConflicts: conflict.hasConflicts,
          conflicts: conflict.conflicts,
        },
      }
    }

    const offset = params.offset ?? 0
    const limit = normalizeLimit(params.limit)
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
        truncated: formatted.truncated,
        hasConflicts: conflict.hasConflicts,
        conflicts: conflict.conflicts,
      },
    }
  },
})
