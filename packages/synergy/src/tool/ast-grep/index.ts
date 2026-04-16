import z from "zod"
import { Tool } from "../tool"
import { Instance } from "../../scope/instance"
import { runSg, formatSearchResult } from "./cli"
import { AST_GREP_LANGUAGES, type AstGrepLanguage } from "./types"
import DESCRIPTION from "./index.txt"

function getEmptyResultHint(pattern: string, lang: AstGrepLanguage): string | null {
  const src = pattern.trim()

  if (lang === "python") {
    if (src.startsWith("class ") && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
    if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":")) {
      const withoutColon = src.slice(0, -1)
      return `Hint: Remove trailing colon. Try: "${withoutColon}"`
    }
  }

  if (["javascript", "typescript", "tsx"].includes(lang)) {
    if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
      return `Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"`
    }
  }

  return null
}

const parameters = z.object({
  pattern: z
    .string()
    .describe(
      "AST pattern with meta-variables ($VAR for single node, $$$ for multiple nodes). Must be a complete AST node.",
    ),
  lang: z.enum(AST_GREP_LANGUAGES).describe("Target language for AST parsing"),
  paths: z.array(z.string()).optional().describe("Paths to search (default: current directory)"),
  globs: z.array(z.string()).optional().describe("Include/exclude globs (prefix ! to exclude)"),
  context: z.number().optional().describe("Number of context lines around each match"),
})

export const AstGrepTool = Tool.define("ast_grep", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    if (!params.lang) {
      throw new Error("lang is required")
    }

    await ctx.ask({
      permission: "ast_grep",
      patterns: [params.pattern],
      metadata: {
        pattern: params.pattern,
        lang: params.lang,
        paths: params.paths,
        globs: params.globs,
      },
    })

    const cwd = Instance.directory
    const result = await runSg({
      pattern: params.pattern,
      lang: params.lang,
      paths: params.paths,
      globs: params.globs,
      context: params.context,
      cwd,
    })

    let output = formatSearchResult(result)

    if (result.matches.length === 0 && !result.error) {
      const hint = getEmptyResultHint(params.pattern, params.lang)
      if (hint) {
        output += `\n\n${hint}`
      }
    }

    ctx.metadata({
      metadata: {
        matches: result.matches.length,
        truncated: result.truncated,
        truncatedReason: result.truncatedReason,
      },
    })

    return {
      title: `${params.lang}: ${params.pattern}`,
      metadata: {
        matches: result.matches.length,
        truncated: result.truncated,
      },
      output,
    }
  },
})
