import { chmod, lstat, realpath, rename, unlink } from "node:fs/promises"
import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./resolve-conflicts.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { detectConflicts } from "../conflict/detect"
import { resolveAllConflicts } from "../conflict/resolve"
import { normalizeContent, splitContentLines } from "../hashline/tag"
import { stripBom } from "../hashline/normalize"
import { SessionHashlineStore } from "../hashline/store"
import { RuntimeReloadPath } from "../config/reload-path"
import { RuntimeReloadExecutor } from "../config/reload-executor"
import { formatCompactReloadResult } from "../config/reload-schema"
import { diffStats, displayPath, hashlineHeaderFor, recordSeenSessionLines, resolveFilePath } from "./anchored-file"
import { captureWriteDiagnosticsBefore, collectWriteDiagnostics } from "./write-quality"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { ScopeContext } from "@/scope/context"
import { Filesystem } from "@/util/filesystem"

const ConflictNumber = z.number().int().positive().describe("The 1-based conflict number in current file order")
const ConflictStyle = z
  .enum(["merge", "diff3"])
  .optional()
  .describe("Use diff3 only when the block has a real ||||||| base section; defaults to merge")

const Resolution = z.discriminatedUnion("strategy", [
  z.object({ conflict: ConflictNumber, strategy: z.literal("ours"), conflictStyle: ConflictStyle }),
  z.object({ conflict: ConflictNumber, strategy: z.literal("theirs"), conflictStyle: ConflictStyle }),
  z.object({
    conflict: ConflictNumber,
    strategy: z.literal("both"),
    order: z.enum(["ours-theirs", "theirs-ours"]).optional().describe("Defaults to ours-theirs"),
    conflictStyle: ConflictStyle,
  }),
  z.object({
    conflict: ConflictNumber,
    strategy: z.literal("custom"),
    content: z
      .string()
      .describe("Final replacement content for the entire conflict block; must not contain a complete conflict block"),
  }),
])

async function readUtf8TextPreservingBom(file: ReturnType<typeof Bun.file>): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await file.arrayBuffer())
}
function staleTagError(title: string): Error {
  return new Error(
    `Unknown or out-of-date tag for ${title}. The file changed since that conflict view. Use view_file again and retry with the current tag and conflict numbers.`,
  )
}

async function assertPathStaysWithinWorkspace(filePath: string, title: string): Promise<void> {
  const physicalPath = await realpath(filePath).catch(() => undefined)
  if (!physicalPath) throw new Error(`File not found: ${title}`)
  const workspacePath = await realpath(ScopeContext.current.directory)
  if (!Filesystem.contains(workspacePath, physicalPath)) {
    throw new Error(`Refusing to resolve conflicts through a path that escapes the active workspace: ${title}`)
  }
}

async function atomicReplace(filePath: string, content: string, mode: number): Promise<void> {
  const temporary = `${filePath}.synergy-resolve-${process.pid}-${Date.now()}`
  try {
    await Bun.write(temporary, content)
    await chmod(temporary, mode)
    await rename(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export const ResolveConflictsTool = Tool.define("resolve_conflicts", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the conflicted file returned by view_file"),
    tag: z
      .string()
      .regex(/^[0-9A-F]{4}$/i)
      .describe("The current [path#TAG] tag returned by view_file"),
    resolutions: z
      .array(Resolution)
      .min(1)
      .describe("Exactly one resolution for every current conflict block, numbered in file order starting at 1"),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    const title = displayPath(filePath)

    return FileTime.withLock(
      filePath,
      async () => {
        await assertPathStaysWithinWorkspace(filePath, title)
        const stats = await lstat(filePath).catch(() => undefined)
        if (!stats) throw new Error(`File not found: ${title}`)
        if (stats.isSymbolicLink()) throw new Error(`Refusing to resolve conflicts through a symbolic link: ${title}`)
        if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${title}`)

        const file = Bun.file(filePath)

        const oldContent = await readUtf8TextPreservingBom(file)
        const snapshots = SessionHashlineStore.get(ctx.sessionID)
        const stored = snapshots.byHash(filePath, params.tag.toUpperCase())
        if (!stored || stored.text !== normalizeContent(stripBom(oldContent).text)) throw staleTagError(title)

        const previousConflict = detectConflicts(oldContent)
        if (!previousConflict.hasConflicts)
          throw new Error(`The file ${title} does not contain conflict markers to resolve.`)

        const candidate = resolveAllConflicts(oldContent, params.resolutions)
        const candidateConflict = detectConflicts(candidate)
        if (candidateConflict.hasConflicts) {
          throw new Error(`Refusing to write ${title} because the resolved candidate still contains conflict markers.`)
        }

        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, candidate))
        const changeSummary = diffStats(diff)
        const askFilediff = SnapshotSchema.fromContents({
          file: title,
          before: oldContent,
          after: candidate,
          ...changeSummary,
          preview: diff,
        })
        await ctx.ask({
          permission: "resolve_conflicts",
          patterns: [title],
          metadata: {
            filepath: filePath,
            path: title,
            diff,
            filediff: askFilediff,
            changeSummary,
            conflicts: previousConflict.conflicts,
            resolvedConflicts: previousConflict.conflicts.length,
            strategies: params.resolutions.map((resolution) => resolution.strategy),
          },
        })
        ctx.abort.throwIfAborted()
        await assertPathStaysWithinWorkspace(filePath, title)
        const currentStats = await lstat(filePath).catch(() => undefined)
        if (!currentStats) throw new Error(`File not found: ${title}`)
        if (currentStats.isSymbolicLink())
          throw new Error(`Refusing to resolve conflicts through a symbolic link: ${title}`)
        if (currentStats.isDirectory()) throw new Error(`Path is a directory, not a file: ${title}`)
        const currentContent = await readUtf8TextPreservingBom(Bun.file(filePath))
        if (currentContent !== oldContent) throw staleTagError(title)

        const beforeDiagnostics = await captureWriteDiagnosticsBefore()
        await atomicReplace(filePath, candidate, currentStats.mode)
        await Bus.publish(File.Event.Edited, { file: filePath })

        const finalContent = await readUtf8TextPreservingBom(Bun.file(filePath))
        const finalConflict = detectConflicts(finalContent)
        if (finalConflict.hasConflicts) {
          throw new Error(
            `Conflict resolution wrote ${title}, but format-on-write left conflict markers at lines ${finalConflict.conflicts
              .map((conflict) => `${conflict.startLine}-${conflict.endLine}`)
              .join(", ")}.`,
          )
        }

        FileTime.read(ctx.sessionID, filePath)
        const diagnostics = await collectWriteDiagnostics(filePath, { before: beforeDiagnostics })
        const runtimeReloadTargets = RuntimeReloadPath.detectTargetsForFile(filePath)
        const runtimeReloadScope = RuntimeReloadPath.detectScopeForFile(filePath) ?? "auto"
        const runtimeReload = runtimeReloadTargets.length
          ? await RuntimeReloadExecutor.reload({
              targets: runtimeReloadTargets,
              scope: runtimeReloadScope,
              reason: `resolve_conflicts:${title}`,
            })
          : undefined
        const builtinSourceWarning = RuntimeReloadPath.builtinSourceEditWarning(filePath)

        const header = hashlineHeaderFor(ctx.sessionID, filePath, stripBom(finalContent).text)
        const tag = header.match(/#([0-9A-F]{4})\]$/)?.[1]
        if (tag) {
          recordSeenSessionLines(
            ctx.sessionID,
            filePath,
            splitContentLines(finalContent).map((_, index) => index + 1),
            tag,
          )
        }

        const finalDiff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, finalContent))
        const finalChangeSummary = diffStats(finalDiff)
        const filediff = SnapshotSchema.fromContents({
          file: title,
          before: oldContent,
          after: finalContent,
          ...finalChangeSummary,
          preview: finalDiff,
        })

        let output = `${header}\nResolved ${previousConflict.conflicts.length} conflict block${previousConflict.conflicts.length === 1 ? "" : "s"}.`
        output += diagnostics.output
        if (runtimeReload) output += `\n${formatCompactReloadResult(runtimeReload)}`
        if (builtinSourceWarning) output += `\n${builtinSourceWarning}`

        return {
          title,
          output,
          metadata: {
            filepath: filePath,
            path: title,
            tag,
            diff: finalDiff,
            filediff,
            changeSummary: finalChangeSummary,
            resolvedConflicts: previousConflict.conflicts.length,
            strategies: params.resolutions.map((resolution) => resolution.strategy),
            hasConflicts: false,
            conflicts: [],
            diagnostics: diagnostics.diagnostics,
            runtimeReload,
            builtinSourceWarning,
          },
        }
      },
      { signal: ctx.abort },
    )
  },
})
