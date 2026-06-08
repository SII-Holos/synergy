import z from "zod"
import DESCRIPTION from "./scan-files.txt"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import { Instance } from "../scope/instance"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  markFileRead,
  readTextFile,
  resolveFilePath,
} from "./anchored-file"

function noMatchGuidance(params: { path?: string; include?: string; globs?: string[] }): string[] {
  const guidance = [
    "No matches found for this search.",
    "Do not conclude the symbol or text is absent until you broaden the search once.",
  ]
  if (params.include || params.globs?.length) {
    guidance.push(
      "The include/globs filters may be too narrow. Try again without include/globs or with a broader file pattern.",
    )
  }
  if (params.path) {
    guidance.push("If the searched concept may live elsewhere, try the parent directory or the repository root.")
  }
  guidance.push("For partial code fragments, literals, error messages, and names, keep using scan_files.")
  guidance.push("For a known complete syntax shape, use parse_code with a complete AST pattern.")
  return guidance
}

function formatNoMatches(params: { pattern: string; path?: string; include?: string; globs?: string[] }): string {
  const details = [
    `Pattern: ${params.pattern}`,
    `Search path: ${params.path ?? "current scope"}`,
    params.include ? `Include: ${params.include}` : undefined,
    params.globs?.length ? `Globs: ${params.globs.join(", ")}` : undefined,
  ].filter(Boolean)
  return [...details, "", ...noMatchGuidance(params)].join("\n")
}

function formatRipgrepFailure(stderr: string): string {
  return [
    "scan_files could not run this regular expression.",
    stderr.trim(),
    "",
    "Check the regex syntax, escape literal metacharacters like (, ), [, ], {, }, and retry.",
    "If you meant a literal string, remove unnecessary regex punctuation or escape it.",
  ]
    .filter(Boolean)
    .join("\n")
}

export const ScanFilesTool = Tool.define("scan_files", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z
      .string()
      .describe(
        "Regular expression to search for; matched files are returned with [path#TAG] headers for follow-up edits",
      ),
    path: z.string().optional().describe("Directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search, e.g. "*.ts"'),
    globs: z.array(z.string()).optional().describe("Additional include/exclude globs; prefix exclusions with !"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    await ctx.ask({
      permission: "scan_files",
      patterns: [params.pattern],
      metadata: { pattern: params.pattern, path: params.path, include: params.include, globs: params.globs },
    })

    const searchPath = params.path ? resolveFilePath(params.path) : Instance.directory
    await assertInsideOrAsk(searchPath, ctx)
    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) args.push("--glob", params.include)
    for (const glob of params.globs ?? []) args.push("--glob", glob)
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode === 1)
      return {
        title: params.pattern,
        metadata: {
          matches: 0,
          files: [] as string[],
          matchLines: {} as Record<string, number[]>,
          conflicts: {} as Record<string, ReturnType<typeof detectConflicts>["conflicts"]>,
          tags: {} as Record<string, string>,
          truncated: false,
          guidance: noMatchGuidance(params),
        },
        output: formatNoMatches(params),
      }
    if (exitCode !== 0) throw new Error(formatRipgrepFailure(stderr))

    const matches = stdout.trim().split(/\r?\n/).filter(Boolean)
    const byFile = new Map<string, { count: number; lines: number[] }>()
    for (const line of matches) {
      const [filePath, lineNumberRaw] = line.split("|")
      const lineNumber = Number(lineNumberRaw)
      if (!filePath || !Number.isInteger(lineNumber)) continue
      const entry = byFile.get(filePath) ?? { count: 0, lines: [] }
      entry.count++
      if (!entry.lines.includes(lineNumber)) entry.lines.push(lineNumber)
      byFile.set(filePath, entry)
    }

    const blocks: string[] = []
    const files: string[] = []
    const matchLines: Record<string, number[]> = {}
    const conflicts: Record<string, ReturnType<typeof detectConflicts>["conflicts"]> = {}
    const tags: Record<string, string> = {}
    for (const [filePath, entry] of byFile.entries()) {
      const content = await readTextFile(filePath).catch(() => undefined)
      if (content === undefined) continue
      const { output, tag } = formatRecordedBlock(ctx.sessionID, filePath, content)
      markFileRead(ctx.sessionID, filePath)
      const pathLabel = displayPath(filePath)
      const conflict = detectConflicts(content)
      const warning = conflictWarning(conflict)
      const lines = entry.lines.sort((a, b) => a - b)
      blocks.push(`${warning ? `${warning}\n` : ""}Matches in [${pathLabel}#${tag}]: ${lines.join(", ")}\n${output}`)
      files.push(pathLabel)
      matchLines[pathLabel] = lines
      tags[pathLabel] = tag
      if (conflict.hasConflicts) conflicts[pathLabel] = conflict.conflicts
    }

    return {
      title: params.pattern,
      output: blocks.length ? blocks.join("\n\n") : formatNoMatches(params),
      metadata: {
        matches: matches.length,
        files,
        matchLines,
        tags,
        conflicts,
        truncated: false,
        guidance: blocks.length ? [] : noMatchGuidance(params),
      },
    }
  },
})
