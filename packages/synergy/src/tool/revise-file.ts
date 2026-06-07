import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./revise-file.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { detectConflicts } from "../conflict/detect"
import { RuntimeReload } from "../runtime/reload"
import { formatHashlineBlock } from "../hashline/format"
import { parseHashlinePatch } from "../hashline/patch"
import { applyPatchOps } from "../hashline/revise"
import { recoverPatchOps } from "../hashline/recovery"
import { SessionHashlineStore } from "../hashline/store"
import { computeTag, normalizeContent } from "../hashline/tag"
import { assertInsideOrAsk, diffStats, displayPath, resolveFilePath } from "./anchored-file"
import { collectWriteDiagnostics } from "./write-quality"

function summarizeOperations(operations: ReturnType<typeof parseHashlinePatch>["ops"]): string[] {
  return operations.map((op) => {
    if (op.type === "replace") return `replace ${op.startLine}..${op.endLine}`
    if (op.type === "delete") return `delete ${op.startLine}..${op.endLine}`
    if (op.position === "before" || op.position === "after") return `insert ${op.position} ${op.lineNumber}`
    return `insert ${op.position}`
  })
}

const noRuntimeReload = undefined as Awaited<ReturnType<typeof RuntimeReload.reload>> | undefined

export const ReviseFileTool = Tool.define("revise_file", {
  description: DESCRIPTION,
  parameters: z.object({
    input: z
      .string()
      .describe(
        "Patch text beginning with a real [path#TAG] header returned by an anchored tool; body rows must be final +TEXT lines",
      ),
  }),
  async execute(params, ctx) {
    const patch = parseHashlinePatch(params.input)
    const filePath = resolveFilePath(patch.path)
    const title = displayPath(filePath)
    await assertInsideOrAsk(filePath, ctx)

    return FileTime.withLock(
      filePath,
      async () => {
        const store = SessionHashlineStore.get(ctx.sessionID)
        const stored = store.get(filePath, patch.tag)
        if (stored === undefined) {
          throw new Error(
            `Unknown or out-of-date [path#TAG] header for ${patch.path}. STOP: do not stack additional edits. Use view_file, scan_files, parse_code, or save_file to get a current header, then retry with that header.`,
          )
        }

        const file = Bun.file(filePath)
        const stats = await file.stat().catch(() => undefined)
        if (!stats) throw new Error(`File not found: ${filePath}`)
        if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)

        const oldContent = normalizeContent(await file.text())
        const conflict = detectConflicts(oldContent)
        if (conflict.hasConflicts) {
          const ranges = conflict.conflicts.map((item) => `${item.startLine}-${item.endLine}`).join(", ")
          throw new Error(
            `Refusing revise_file on ${patch.path} because it contains unresolved merge conflict markers at lines ${ranges}. Resolve the conflict first, or use save_file only for an intentional full-file resolution.`,
          )
        }

        const liveTag = computeTag(oldContent)
        let activeOps = patch.ops
        let recoveryMode: "three-way-merge" | undefined
        if (liveTag !== patch.tag) {
          try {
            const recovery = recoverPatchOps(stored, oldContent, patch.ops)
            activeOps = recovery.ops
            recoveryMode = recovery.mode
          } catch (error) {
            const reason = error instanceof Error ? error.message : "cannot recover safely"
            throw new Error(
              `The [path#TAG] header for ${patch.path} is out of date, and this edit could not be safely mapped onto the current file: ${reason}. STOP: do not stack additional edits. Re-run view_file and retry with the current header.`,
            )
          }
        }

        if (!recoveryMode) await FileTime.assert(ctx.sessionID, filePath)
        const newContent = applyPatchOps(oldContent, activeOps)
        if (newContent === oldContent) {
          const diagnostics = await collectWriteDiagnostics(filePath)
          return {
            title,
            output: `${formatHashlineBlock(title, patch.tag, oldContent)}\nNo-op: patch parsed cleanly but produced no change. The targeted body rows already match the current file. Do not widen ranges; verify the header and line numbers before retrying.${diagnostics.output}`,
            metadata: {
              filepath: filePath,
              path: title,
              tag: patch.tag,
              applied: false,
              operations: 0,
              diff: "",
              filediff: { file: title, path: title, before: oldContent, after: oldContent, additions: 0, deletions: 0 },
              operationSummary: summarizeOperations(activeOps),
              changeSummary: { additions: 0, deletions: 0 },
              recovered: recoveryMode !== undefined,
              recoveryMode,
              diagnostics: diagnostics.diagnostics,
              runtimeReload: noRuntimeReload,
              builtinSourceWarning: undefined,
            },
          }
        }

        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))
        const changeSummary = diffStats(diff)
        await ctx.ask({
          permission: "revise_file",
          patterns: [title],
          metadata: {
            filepath: filePath,
            path: title,
            diff,
            filediff: { file: title, path: title, before: oldContent, after: newContent, ...changeSummary },
            operationSummary: summarizeOperations(activeOps),
            changeSummary,
            recovered: recoveryMode !== undefined,
            recoveryMode,
          },
        })

        await Bun.write(filePath, newContent)
        await Bus.publish(File.Event.Edited, { file: filePath })
        const finalContent = await Bun.file(filePath).text()
        FileTime.read(ctx.sessionID, filePath)

        const diagnostics = await collectWriteDiagnostics(filePath)
        const runtimeReloadTargets = RuntimeReload.detectTargetsForFile(filePath)
        const runtimeReloadScope = RuntimeReload.detectScopeForFile(filePath) ?? "auto"
        const runtimeReload = runtimeReloadTargets.length
          ? await RuntimeReload.reload({
              targets: runtimeReloadTargets,
              scope: runtimeReloadScope,
              reason: `revise_file:${title}`,
            })
          : undefined
        const builtinSourceWarning = RuntimeReload.builtinSourceEditWarning(filePath)
        const newTag = store.record(filePath, finalContent)
        const finalDiff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, finalContent))
        const finalChangeSummary = diffStats(finalDiff)
        let output = formatHashlineBlock(title, newTag, finalContent)
        output += diagnostics.output
        if (runtimeReload) output += `\nRuntime reload applied: ${runtimeReload.executed.join(",")}`
        if (builtinSourceWarning) output += `\n${builtinSourceWarning}`

        return {
          title,
          output,
          metadata: {
            filepath: filePath,
            path: title,
            tag: newTag,
            applied: true,
            operations: activeOps.length,
            diff: finalDiff,
            filediff: { file: title, path: title, before: oldContent, after: finalContent, ...finalChangeSummary },
            operationSummary: summarizeOperations(activeOps),
            changeSummary: finalChangeSummary,
            diagnostics: diagnostics.diagnostics,
            recovered: recoveryMode !== undefined,
            recoveryMode,
            runtimeReload,
            builtinSourceWarning,
          },
        }
      },
      { signal: ctx.abort },
    )
  },
})
