import z from "zod"
import DESCRIPTION from "./parse-code.txt"
import { Tool } from "./tool"
import { runSg } from "./ast-grep/cli"
import { AST_GREP_LANGUAGES } from "./ast-grep/types"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import { Instance } from "../scope/instance"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  formatSelectedLines,
  markFileRead,
  readTextFileUnderSnapshotCap,
  resolveFilePath,
  splitDisplayLines,
} from "./anchored-file"

const DEFAULT_AST_LIMIT = 50
const MAX_AST_LIMIT = 100

function parseGuidance(params: { pattern: string; lang: string; paths?: string[]; globs?: string[] }): string[] {
  const guidance = [
    "AST patterns must be complete, parseable syntax for the selected language.",
    "If you are searching for a literal or partial fragment, use scan_files instead.",
  ]
  if (params.globs?.length)
    guidance.push("The globs filter may be too narrow. Retry without globs if the structure might be elsewhere.")
  if (params.paths?.length)
    guidance.push("If the structure may live outside these paths, retry from a broader parent directory.")
  guidance.push(
    "TypeScript examples: export namespace $NAME { $$$ } · function $NAME($$$) { $$$ } · const $NAME = $VALUE",
  )
  return guidance
}

function formatParseError(
  params: { pattern: string; lang: string; paths?: string[]; globs?: string[] },
  error: string,
): string {
  return [
    "The AST pattern is not parseable for this language.",
    `Pattern: ${params.pattern}`,
    `Language: ${params.lang}`,
    "",
    error.trim(),
    "",
    ...parseGuidance(params),
  ].join("\n")
}

function formatNoStructuralMatches(params: {
  pattern: string
  lang: string
  paths?: string[]
  globs?: string[]
}): string {
  return [
    "No structural matches found.",
    `Pattern: ${params.pattern}`,
    `Language: ${params.lang}`,
    `Search path: ${params.paths?.join(", ") || "current scope"}`,
    params.globs?.length ? `Globs: ${params.globs.join(", ")}` : undefined,
    "",
    "Do not conclude the code is absent until you broaden the path/filter once or try scan_files for literal text.",
    ...parseGuidance(params),
  ]
    .filter(Boolean)
    .join("\n")
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_AST_LIMIT
  return Math.min(Math.floor(value), MAX_AST_LIMIT)
}

export const ParseCodeTool = Tool.define("parse_code", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z
      .string()
      .describe("AST pattern with meta-variables; must be a complete, parseable AST node for the selected language"),
    lang: z.enum(AST_GREP_LANGUAGES).describe("Target language for AST parsing"),
    paths: z.array(z.string()).optional().describe("Paths to search; defaults to the current working directory"),
    globs: z.array(z.string()).optional().describe("Additional include/exclude globs; prefix exclusions with !"),
    context: z.number().optional().describe("Number of context lines to include around each structural match"),
    limit: z.number().int().min(1).optional().describe("Maximum matches to return; defaults to 50"),
    skip: z.number().int().min(0).optional().describe("Matches to skip for pagination"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    await ctx.ask({
      permission: "parse_code",
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
    const limit = normalizeLimit(params.limit)
    const skip = Math.max(params.skip ?? 0, 0)

    if (result.error)
      return {
        title: `${params.lang}: ${params.pattern}`,
        metadata: {
          matches: 0,
          returnedMatches: 0,
          files: [] as string[],
          matchLines: {} as Record<string, number[]>,
          matchRanges: {} as Record<string, string[]>,
          conflicts: {} as Record<string, ReturnType<typeof detectConflicts>["conflicts"]>,
          tags: {} as Record<string, string>,
          truncated: result.truncated,
          limitReached: false,
          nextSkip: undefined as number | undefined,
          skip,
          limit,
          oversizedFiles: [] as string[],
          guidance: parseGuidance(params),
        },
        output: formatParseError(params, result.error),
      }

    const selectedMatches = result.matches.slice(skip, skip + limit)
    const limitReached = result.truncated || result.matches.length > skip + limit
    const nextSkip = result.matches.length > skip + limit ? skip + limit : undefined
    const byFile = new Map<string, { count: number; lines: number[]; ranges: string[] }>()
    for (const match of selectedMatches) {
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
    const conflicts: Record<string, ReturnType<typeof detectConflicts>["conflicts"]> = {}
    const tags: Record<string, string> = {}
    const oversizedFiles: string[] = []

    for (const [rawPath, entry] of byFile.entries()) {
      const filePath = resolveFilePath(rawPath)
      const content = await readTextFileUnderSnapshotCap(filePath).catch(() => undefined)
      const pathLabel = displayPath(filePath)
      const lines = entry.lines.sort((a, b) => a - b)
      if (content === undefined) {
        oversizedFiles.push(pathLabel)
        blocks.push(`AST matches in ${pathLabel} (file too large for anchored tag): ${entry.ranges.join(", ")}`)
        files.push(pathLabel)
        matchLines[pathLabel] = lines
        matchRanges[pathLabel] = entry.ranges
        continue
      }

      const contentLines = splitDisplayLines(content)
      const { tag } = formatRecordedBlock(ctx.sessionID, filePath, content)
      markFileRead(ctx.sessionID, filePath)
      const conflict = detectConflicts(content)
      const warning = conflictWarning(conflict)
      blocks.push(
        `${warning ? `${warning}\n` : ""}AST matches in [${pathLabel}#${tag}]: ${entry.ranges.join(", ")}\n${formatSelectedLines(contentLines, lines).output}`,
      )
      files.push(pathLabel)
      matchLines[pathLabel] = lines
      matchRanges[pathLabel] = entry.ranges
      tags[pathLabel] = tag
      if (conflict.hasConflicts) conflicts[pathLabel] = conflict.conflicts
    }

    const footer = limitReached
      ? `\n\n[Result limit reached. Use skip=${nextSkip ?? skip + limit} to continue, or narrow paths/globs/pattern.]`
      : ""
    const oversized = oversizedFiles.length
      ? `\n\n[${oversizedFiles.length} matched file(s) were too large for anchored tags: ${oversizedFiles.join(", ")}. Use narrower searches or inspect smaller ranges.]`
      : ""

    return {
      title: `${params.lang}: ${params.pattern}`,
      output: blocks.length ? `${blocks.join("\n\n")}${footer}${oversized}` : formatNoStructuralMatches(params),
      metadata: {
        matches: result.totalMatches,
        returnedMatches: selectedMatches.length,
        files,
        matchLines,
        matchRanges,
        conflicts,
        tags,
        truncated: limitReached || oversizedFiles.length > 0,
        limitReached,
        nextSkip,
        skip,
        limit,
        oversizedFiles,
        guidance: blocks.length ? [] : parseGuidance(params),
      },
    }
  },
})
