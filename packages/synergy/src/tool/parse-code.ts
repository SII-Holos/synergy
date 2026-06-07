import z from "zod"
import DESCRIPTION from "./parse-code.txt"
import { Tool } from "./tool"
import { runSg } from "./ast-grep/cli"
import { AST_GREP_LANGUAGES } from "./ast-grep/types"
import { Instance } from "../scope/instance"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  markFileRead,
  readTextFile,
  resolveFilePath,
} from "./anchored-file"

export const ParseCodeTool = Tool.define("parse_code", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z
      .string()
      .describe("AST pattern with meta-variables; must be a complete, parseable AST node for the selected language"),
    lang: z.enum(AST_GREP_LANGUAGES).describe("Target language for AST parsing"),
    paths: z.array(z.string()).optional().describe("Paths to search; defaults to the current working directory"),
    globs: z.array(z.string()).optional().describe("Additional include/exclude globs; prefix exclusions with !"),
    context: z
      .number()
      .optional()
      .describe("Number of context lines ast-grep should include around each structural match"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    await ctx.ask({
      permission: "ast_grep",
      patterns: [params.pattern],
      metadata: { pattern: params.pattern, lang: params.lang, paths: params.paths, globs: params.globs },
    })

    for (const searchPath of params.paths?.length ? params.paths.map(resolveFilePath) : [Instance.directory]) {
      await assertInsideOrAsk(searchPath, ctx)
    }

    const result = await runSg({
      pattern: params.pattern,
      lang: params.lang,
      paths: params.paths,
      globs: params.globs,
      context: params.context,
      cwd: Instance.directory,
    })
    if (result.error)
      return {
        title: `${params.lang}: ${params.pattern}`,
        metadata: {
          matches: 0,
          files: [] as string[],
          matchLines: {} as Record<string, number[]>,
          matchRanges: {} as Record<string, string[]>,
          truncated: result.truncated,
        },
        output: result.error,
      }

    const byFile = new Map<string, { count: number; lines: number[]; ranges: string[] }>()
    for (const match of result.matches) {
      const entry = byFile.get(match.file) ?? { count: 0, lines: [], ranges: [] }
      entry.count++
      const startLine = match.range.start.line + 1
      const endLine = match.range.end.line + 1
      if (!entry.lines.includes(startLine)) entry.lines.push(startLine)
      entry.ranges.push(`${startLine}:${match.range.start.column + 1}-${endLine}:${match.range.end.column + 1}`)
      byFile.set(match.file, entry)
    }

    const blocks: string[] = []
    const files: string[] = []
    const matchLines: Record<string, number[]> = {}
    const matchRanges: Record<string, string[]> = {}
    for (const [rawPath, entry] of byFile.entries()) {
      const filePath = resolveFilePath(rawPath)
      const content = await readTextFile(filePath).catch(() => undefined)
      if (content === undefined) continue
      const { output, tag } = formatRecordedBlock(ctx.sessionID, filePath, content)
      markFileRead(ctx.sessionID, filePath)
      const pathLabel = displayPath(filePath)
      const lines = entry.lines.sort((a, b) => a - b)
      blocks.push(`AST matches in [${pathLabel}#${tag}]: ${entry.ranges.join(", ")}\n${output}`)
      files.push(pathLabel)
      matchLines[pathLabel] = lines
      matchRanges[pathLabel] = entry.ranges
    }

    return {
      title: `${params.lang}: ${params.pattern}`,
      output: blocks.length ? blocks.join("\n\n") : "No matches found",
      metadata: { matches: result.matches.length, files, matchLines, matchRanges, truncated: result.truncated },
    }
  },
})
