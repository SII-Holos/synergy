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
  diffStats,
  displayPath,
  ensureParentDir,
  hashlineHeaderFor,
  recordSeenSessionLines,
  resolveFilePath,
} from "./anchored-file"
import { stripHashlineDisplayPrefixes } from "../hashline/format"
import { splitContentLines } from "../hashline/tag"
import { collectWriteDiagnostics } from "./write-quality"
import { SnapshotSchema } from "@/session/snapshot-schema"

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
        const askFilediff = SnapshotSchema.fromContents({
          file: title,
          before: oldContent,
          after: content,
          ...changeSummary,
          preview: diff,
        })
        await ctx.ask({
          permission: "save_file",
          patterns: [title],
          metadata: {
            filepath: filePath,
            path: title,
            diff,
            filediff: askFilediff,
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
            tag,
            diff: finalDiff,
            filediff,
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
