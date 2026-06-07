import z from "zod"
import DESCRIPTION from "./view-file.txt"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  markFileRead,
  readTextFile,
  resolveFilePath,
} from "./anchored-file"

const DEFAULT_READ_LIMIT = 2000
const MIN_READ_LIMIT = 120

export const ViewFileTool = Tool.define("view_file", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to view"),
    offset: z.coerce.number().describe("The line number to start viewing from (0-based)").optional(),
    limit: z.coerce.number().int().describe("The number of lines to view (defaults to 2000, minimum 120)").optional(),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    await assertInsideOrAsk(filePath, ctx)
    await ctx.ask({ permission: "read", patterns: [filePath], metadata: {} })

    const content = await readTextFile(filePath)
    const { tag } = formatRecordedBlock(ctx.sessionID, filePath, content)
    markFileRead(ctx.sessionID, filePath)
    LSP.touchFile(filePath, false)

    const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    if (lines.at(-1) === "") lines.pop()
    const offset = params.offset ?? 0
    const limit = Math.max(params.limit ?? DEFAULT_READ_LIMIT, MIN_READ_LIMIT)
    const shown = lines.slice(offset, offset + limit)
    const body = shown.map((line, index) => `${offset + index + 1}:${line}`).join("\n")
    const output = body ? `[${displayPath(filePath)}#${tag}]\n${body}` : `[${displayPath(filePath)}#${tag}]\n`
    const truncated = offset + shown.length < lines.length

    return {
      title: displayPath(filePath),
      output,
      metadata: {
        path: displayPath(filePath),
        tag,
        offset,
        limit,
        totalLines: lines.length,
        truncated,
      },
    }
  },
})
