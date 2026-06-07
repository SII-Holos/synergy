import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./save-file.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { detectConflicts } from "../conflict/detect"
import { RuntimeReload } from "../runtime/reload"
import {
  assertInsideOrAsk,
  diffStats,
  displayPath,
  ensureParentDir,
  hashlineHeaderFor,
  resolveFilePath,
} from "./anchored-file"
import { stripHashlineDisplayPrefixes } from "../hashline/format"
import { collectWriteDiagnostics } from "./write-quality"

export const SaveFileTool = Tool.define("save_file", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to create or fully overwrite"),
    content: z
      .string()
      .describe("The full final file content to write; use revise_file instead for surgical anchored edits"),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    const title = displayPath(filePath)
    await assertInsideOrAsk(filePath, ctx)

    return FileTime.withLock(
      filePath,
      async () => {
        const file = Bun.file(filePath)
        const exists = await file.exists()
        const oldContent = exists ? await file.text() : ""
        const previousConflict = detectConflicts(oldContent)
        if (exists) await FileTime.assert(ctx.sessionID, filePath).catch(() => {})

        const content = stripHashlineDisplayPrefixes(params.content)
        const contentConflict = detectConflicts(content)
        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, content))
        const changeSummary = diffStats(diff)
        await ctx.ask({
          permission: "save_file",
          patterns: [title],
          metadata: {
            filepath: filePath,
            path: title,
            diff,
            filediff: { file: title, path: title, before: oldContent, after: content, ...changeSummary },
            changeSummary,
            exists,
            hasConflicts: contentConflict.hasConflicts,
            conflicts: contentConflict.conflicts,
            previousHasConflicts: previousConflict.hasConflicts,
            previousConflicts: previousConflict.conflicts,
          },
        })

        await ensureParentDir(filePath)
        await Bun.write(filePath, content)
        await Bus.publish(File.Event.Edited, { file: filePath })
        const finalContent = await Bun.file(filePath).text()
        const finalConflict = detectConflicts(finalContent)
        FileTime.read(ctx.sessionID, filePath)

        const diagnostics = await collectWriteDiagnostics(filePath)
        const runtimeReloadTargets = RuntimeReload.detectTargetsForFile(filePath)
        const runtimeReloadScope = RuntimeReload.detectScopeForFile(filePath) ?? "auto"
        const runtimeReload = runtimeReloadTargets.length
          ? await RuntimeReload.reload({
              targets: runtimeReloadTargets,
              scope: runtimeReloadScope,
              reason: `save_file:${title}`,
            })
          : undefined
        const builtinSourceWarning = RuntimeReload.builtinSourceEditWarning(filePath)
        const header = hashlineHeaderFor(ctx.sessionID, filePath, finalContent)
        const finalDiff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, finalContent))
        const finalChangeSummary = diffStats(finalDiff)
        let output = header
        output += diagnostics.output
        if (runtimeReload) output += `\nRuntime reload applied: ${runtimeReload.executed.join(",")}`
        if (builtinSourceWarning) output += `\n${builtinSourceWarning}`

        return {
          title,
          output,
          metadata: {
            filepath: filePath,
            path: title,
            tag: header.match(/#([0-9A-F]{4})\]$/)?.[1],
            diff: finalDiff,
            filediff: { file: title, path: title, before: oldContent, after: finalContent, ...finalChangeSummary },
            changeSummary: finalChangeSummary,
            exists,
            hasConflicts: finalConflict.hasConflicts,
            conflicts: finalConflict.conflicts,
            previousHasConflicts: previousConflict.hasConflicts,
            previousConflicts: previousConflict.conflicts,
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
