import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { ScopeContext } from "../scope/context"
import path from "path"
import { ProcessOutput } from "../process/output"

const MAX_LINE_LENGTH = 2000
const LIMIT = 100

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const searchPath = params.path
      ? path.isAbsolute(params.path)
        ? params.path
        : path.resolve(ScopeContext.current.directory, params.path)
      : ScopeContext.current.directory

    const matches: Array<{ path: string; lineNum: number; lineText: string }> = []
    let truncated = false
    let truncatedReason: ProcessOutput.LimitReason | "max_matches" | undefined
    try {
      for await (const match of Ripgrep.matches({
        cwd: ScopeContext.current.directory,
        pattern: params.pattern,
        paths: [searchPath],
        glob: params.include ? [params.include] : undefined,
        sortModifiedDesc: true,
        signal: ctx.abort,
      })) {
        matches.push({
          path: match.path.text,
          lineNum: match.line_number,
          lineText: match.lines.text.replace(/\r?\n$/, ""),
        })
        if (matches.length > LIMIT) {
          truncated = true
          truncatedReason = "max_matches"
          break
        }
      }
    } catch (error) {
      if (!(error instanceof ProcessOutput.LimitError)) throw error
      truncated = true
      truncatedReason = error.reason
    }

    const finalMatches = matches.slice(0, LIMIT)

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated, truncatedReason },
        output: truncated
          ? "Search stopped at the output safety limit before a complete match was available. Narrow the path or pattern."
          : "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
        truncatedReason,
      },
      output: outputLines.join("\n"),
    }
  },
})
