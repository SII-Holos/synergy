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
    pattern: z.string().describe("AST pattern with meta-variables. Must be a complete AST node."),
    lang: z.enum(AST_GREP_LANGUAGES).describe("Target language for AST parsing"),
    paths: z.array(z.string()).optional().describe("Paths to search (default: current directory)"),
    globs: z.array(z.string()).optional().describe("Include/exclude globs (prefix ! to exclude)"),
    context: z.number().optional().describe("Number of context lines around each match"),
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
        metadata: { matches: 0, files: [], truncated: result.truncated },
        output: result.error,
      }

    const uniqueFiles = [...new Set(result.matches.map((match) => match.file))]
    const blocks: string[] = []
    const files: string[] = []
    for (const rawPath of uniqueFiles) {
      const filePath = resolveFilePath(rawPath)
      const content = await readTextFile(filePath).catch(() => undefined)
      if (content === undefined) continue
      const { output } = formatRecordedBlock(ctx.sessionID, filePath, content)
      markFileRead(ctx.sessionID, filePath)
      blocks.push(output)
      files.push(displayPath(filePath))
    }

    return {
      title: `${params.lang}: ${params.pattern}`,
      output: blocks.length ? blocks.join("\n\n") : "No matches found",
      metadata: { matches: result.matches.length, files, truncated: result.truncated },
    }
  },
})
