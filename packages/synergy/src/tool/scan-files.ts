import z from "zod"
import DESCRIPTION from "./scan-files.txt"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { conflictWarning, detectConflicts } from "../conflict/detect"
import { ScopeContext } from "../scope/context"
import {
  displayPath,
  formatRecordedBlock,
  formatSelectedLines,
  markFileRead,
  readTextFileUnderSnapshotCap,
  resolveFilePath,
  splitDisplayLines,
  recordSeenSessionLines,
} from "./anchored-file"
import { ToolTimeout } from "./timeout"
import { ProcessOutput } from "../process/output"

const DEFAULT_FILE_LIMIT = 20
const DEFAULT_PER_FILE_LIMIT = 20
const SINGLE_FILE_PER_FILE_LIMIT = 200
const DEFAULT_TIMEOUT_MS = ToolTimeout.DEFAULTS.scanFilesMs

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

function formatRipgrepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message.replace(/^ripgrep failed:\s*/, "") : String(error)
  return [
    "scan_files could not run this regular expression.",
    detail.trim(),
    "",
    "Check the regex syntax, escape literal metacharacters like (, ), [, ], {, }, and retry.",
    "If you meant a literal string, remove unnecessary regex punctuation or escape it.",
  ]
    .filter(Boolean)
    .join("\n")
}

function formatSearchTimeout(timeoutMs: number): string {
  return [
    `scan_files stopped after ${timeoutMs}ms before completing the search.`,
    "Narrow the path/include/globs, use a more specific pattern, or search a smaller directory first.",
  ].join("\n")
}

function normalizePositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function lineWindow(lines: number[]): number[] {
  return [...new Set(lines)].sort((a, b) => a - b)
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
    limitFiles: z.number().int().min(1).optional().describe("Maximum matched files to return; defaults to 20"),
    perFileLimit: z.number().int().min(1).optional().describe("Maximum matched lines per file; defaults to 20"),
    skipFiles: z.number().int().min(0).optional().describe("Matched files to skip for pagination"),
    timeoutMs: z.number().int().min(1000).optional().describe("Search timeout in milliseconds; defaults to 10000"),
    outputMode: z
      .enum(["matches", "files"])
      .optional()
      .describe("matches returns only matching lines; files returns full file blocks for small result sets"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    await ctx.ask({
      permission: "scan_files",
      patterns: [params.pattern],
      metadata: { pattern: params.pattern, path: params.path, include: params.include, globs: params.globs },
    })

    const searchPath = params.path ? resolveFilePath(params.path) : ScopeContext.current.directory
    const perFileLimit = normalizePositiveInt(params.perFileLimit, DEFAULT_PER_FILE_LIMIT, SINGLE_FILE_PER_FILE_LIMIT)
    const limitFiles = normalizePositiveInt(params.limitFiles, DEFAULT_FILE_LIMIT, DEFAULT_FILE_LIMIT)
    const skipFiles = Math.max(params.skipFiles ?? 0, 0)
    const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000)
    const outputMode = params.outputMode ?? "matches"

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = ctx.abort ? AbortSignal.any([ctx.abort, timeoutSignal]) : timeoutSignal
    const byFile = new Map<string, { count: number; lines: number[]; totalLines: number }>()
    const fileIndexes = new Map<string, number>()
    let observedMatches = 0
    let hasNextFile = false
    let truncatedReason: ProcessOutput.LimitReason | undefined

    try {
      for await (const match of Ripgrep.matches({
        cwd: ScopeContext.current.directory,
        pattern: params.pattern,
        paths: [searchPath],
        glob: [...(params.include ? [params.include] : []), ...(params.globs ?? [])],
        maxCountPerFile: perFileLimit,
        sortPath: true,
        signal,
      })) {
        observedMatches++
        const filePath = match.path.text
        let fileIndex = fileIndexes.get(filePath)
        if (fileIndex === undefined) {
          fileIndex = fileIndexes.size
          fileIndexes.set(filePath, fileIndex)
        }
        if (fileIndex < skipFiles) continue
        if (fileIndex >= skipFiles + limitFiles) {
          hasNextFile = true
          break
        }

        const lineNumber = match.line_number
        const entry = byFile.get(filePath) ?? { count: 0, lines: [], totalLines: 0 }
        entry.totalLines++
        if (entry.lines.length < perFileLimit && !entry.lines.includes(lineNumber)) entry.lines.push(lineNumber)
        entry.count++
        byFile.set(filePath, entry)
      }
    } catch (error) {
      if (ctx.abort?.aborted) throw ctx.abort.reason ?? new DOMException("Aborted", "AbortError")
      if (timeoutSignal.aborted) throw new Error(formatSearchTimeout(timeoutMs))
      if (error instanceof ProcessOutput.LimitError) {
        truncatedReason = error.reason
      } else {
        throw new Error(formatRipgrepFailure(error))
      }
    }

    if (observedMatches === 0 && !truncatedReason)
      return {
        title: params.pattern,
        metadata: {
          matches: 0,
          files: [] as string[],
          matchLines: {} as Record<string, number[]>,
          conflicts: {} as Record<string, ReturnType<typeof detectConflicts>["conflicts"]>,
          tags: {} as Record<string, string>,
          truncated: false,
          limitReached: false,
          nextSkipFiles: undefined as number | undefined,
          totalFiles: 0,
          perFileLimit,
          limitFiles,
          skipFiles,
          outputMode,
          oversizedFiles: [] as string[],
          guidance: noMatchGuidance(params),
          truncatedReason: undefined as ProcessOutput.LimitReason | undefined,
        },
        output: formatNoMatches(params),
      }

    const selectedEntries = [...byFile.entries()]
    const limitReached = hasNextFile || truncatedReason !== undefined
    const nextSkipFiles = hasNextFile && selectedEntries.length ? skipFiles + selectedEntries.length : undefined

    const blocks: string[] = []
    const files: string[] = []
    const matchLines: Record<string, number[]> = {}
    const conflicts: Record<string, ReturnType<typeof detectConflicts>["conflicts"]> = {}
    const tags: Record<string, string> = {}
    const oversizedFiles: string[] = []

    for (const [filePath, entry] of selectedEntries) {
      const smallContent = await readTextFileUnderSnapshotCap(filePath).catch(() => undefined)
      const pathLabel = displayPath(filePath)
      if (smallContent === undefined) {
        oversizedFiles.push(pathLabel)
        const lines = lineWindow(entry.lines)
        blocks.push(`Matches in ${pathLabel} (file too large for anchored tag): ${lines.join(", ")}`)
        files.push(pathLabel)
        matchLines[pathLabel] = lines
        continue
      }

      const contentLines = splitDisplayLines(smallContent)
      const { tag } = formatRecordedBlock(ctx.sessionID, filePath, smallContent)
      markFileRead(ctx.sessionID, filePath)
      const conflict = detectConflicts(smallContent)
      const warning = conflictWarning(conflict)
      const lines = lineWindow(entry.lines)
      const header = `Matches in [${pathLabel}#${tag}]: ${lines.join(", ")}`
      const body =
        outputMode === "files"
          ? formatRecordedBlock(ctx.sessionID, filePath, smallContent).output
          : `${header}\n${formatSelectedLines(contentLines, lines).output}`
      blocks.push(`${warning ? `${warning}\n` : ""}${outputMode === "files" ? body : body}`)
      files.push(pathLabel)
      matchLines[pathLabel] = lines
      recordSeenSessionLines(ctx.sessionID, filePath, lines, tag)
      tags[pathLabel] = tag
      if (conflict.hasConflicts) conflicts[pathLabel] = conflict.conflicts
    }

    const footer = hasNextFile
      ? `\n\n[Result limit reached. Use skipFiles=${nextSkipFiles ?? skipFiles + limitFiles} to continue, or narrow path/include/globs/pattern.]`
      : truncatedReason
        ? "\n\n[Output safety limit reached. Narrow path/include/globs/pattern; skipFiles cannot continue past this subprocess limit.]"
        : ""
    const oversized = oversizedFiles.length
      ? `\n\n[${oversizedFiles.length} matched file(s) were too large for anchored tags: ${oversizedFiles.join(", ")}. Use narrower searches or inspect smaller ranges.]`
      : ""

    return {
      title: params.pattern,
      output: blocks.length ? `${blocks.join("\n\n")}${footer}${oversized}` : formatNoMatches(params),
      metadata: {
        matches: observedMatches,
        files,
        matchLines,
        tags,
        conflicts,
        truncated: limitReached || oversizedFiles.length > 0,
        limitReached,
        nextSkipFiles,
        totalFiles: fileIndexes.size,
        perFileLimit,
        limitFiles,
        skipFiles,
        outputMode,
        oversizedFiles,
        truncatedReason,
        guidance: blocks.length ? [] : noMatchGuidance(params),
      },
    }
  },
})
